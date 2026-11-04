import Foundation

/// A flat arena keeps both parsing and destruction independent of JSON nesting depth.
struct RawJSONDocument {
    struct Node {
        enum Value {
            case object, array, string(String), number(String), bool(Bool), null
        }
        /// 0 means no parent; otherwise this is the parent node's index plus one.
        ///
        /// A node is appended only after its value consumes at least one input
        /// byte, so `nodes.count <= RawJSONScanner.maximumBytes` (10,485,760).
        /// The decoded parent index is therefore bounded by `maximumBytes`,
        /// well below `UInt32.max` (4,294,967,295).
        private let encodedParent: UInt32
        /// Present only for object members; compare its UTF-8 bytes, not String equality.
        let key: String?
        let value: Value

        var parent: Int? {
            guard encodedParent != 0 else { return nil }
            guard let parent = Int(exactly: encodedParent - 1) else {
                preconditionFailure("encoded JSON node parent does not fit Int")
            }
            return parent
        }

        fileprivate init(parent: Int?, key: String?, value: Value) {
            if let parent {
                guard let index = UInt32(exactly: parent) else {
                    preconditionFailure("JSON node parent index does not fit UInt32")
                }
                let (encoded, overflow) = index.addingReportingOverflow(1)
                precondition(!overflow, "JSON node parent index overflow")
                encodedParent = encoded
            } else {
                encodedParent = 0
            }
            self.key = key
            self.value = value
        }
    }
    let nodes: [Node]
}

enum RawJSONError: Error, Equatable {
    case tooLarge, invalidUTF8, invalidJSON, duplicateKey
}

enum RawJSONScanner {
    static let maximumBytes = 10_485_760

    static func scan(_ input: Data) throws -> RawJSONDocument {
        var parser = try makeParser(input)
        return try parser.parse()
    }

    private static func makeParser(_ input: Data) throws -> Parser {
        guard input.count <= maximumBytes else { throw RawJSONError.tooLarge }
        guard !input.starts(with: [0xef, 0xbb, 0xbf]),
              String(data: input, encoding: .utf8) != nil else { throw RawJSONError.invalidUTF8 }
        return Parser(bytes: Array(input))
    }

    private struct Frame {
        // 0: first value/key or close; 1: comma or close; 2: value/key after comma;
        // 3: object colon; 4: object value.
        let node: Int
        let object: Bool
        var state = 0
    }

    /// Object-only parser state, separate so array container frames do not
    /// reserve a duplicate-key set or pending key.
    private struct ObjectState {
        var keys = Set<Data>()
        var key: String?
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0
        var nodes: [RawJSONDocument.Node] = []
        var stack: [Frame] = []
        var objectStack: [ObjectState] = []
#if DEBUG
        var peakObjectStateCount = 0
#endif

        var current: UInt8? { index < bytes.count ? bytes[index] : nil }
        mutating func whitespace() {
            while let c = current, c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d { index += 1 }
        }
        mutating func pushObjectState() {
            objectStack.append(ObjectState())
#if DEBUG
            peakObjectStateCount = max(peakObjectStateCount, objectStack.count)
#endif
        }
        mutating func popFrame() {
            let frame = stack.removeLast()
            if frame.object {
                precondition(!objectStack.isEmpty, "object state stack out of sync")
                objectStack.removeLast()
            }
        }
        mutating func parse() throws -> RawJSONDocument {
            whitespace()
            try value(parent: nil, key: nil)
            while !stack.isEmpty {
                whitespace()
                let last = stack.count - 1
                let isObject = stack[last].object
                let state = stack[last].state
                guard let c = current else { throw RawJSONError.invalidJSON }
                if state == 1 {
                    if c == (isObject ? 0x7d : 0x5d) {
                        index += 1
                        popFrame()
                        continue
                    }
                    guard c == 0x2c else { throw RawJSONError.invalidJSON }
                    index += 1; stack[last].state = 2; continue
                }
                if state == 0 && c == (isObject ? 0x7d : 0x5d) {
                    index += 1
                    popFrame()
                    continue
                }
                if isObject && (state == 0 || state == 2) {
                    guard c == 0x22 else { throw RawJSONError.invalidJSON }
                    let key = try string()
                    let object = objectStack.count - 1
                    guard objectStack[object].keys.insert(Data(key.utf8)).inserted else { throw RawJSONError.duplicateKey }
                    objectStack[object].key = key; stack[last].state = 3; continue
                }
                if isObject && state == 3 {
                    guard c == 0x3a else { throw RawJSONError.invalidJSON }
                    index += 1; stack[last].state = 4; continue
                }
                guard (!isObject && (state == 0 || state == 2)) || (isObject && state == 4) else {
                    throw RawJSONError.invalidJSON
                }
                let parent = stack[last].node
                let key: String?
                if isObject {
                    let object = objectStack.count - 1
                    key = objectStack[object].key
                    objectStack[object].key = nil
                } else {
                    key = nil
                }
                stack[last].state = 1
                try value(parent: parent, key: key)
            }
            whitespace()
            guard index == bytes.count else { throw RawJSONError.invalidJSON }
            return RawJSONDocument(nodes: nodes)
        }

        mutating func value(parent: Int?, key: String?) throws {
            guard let c = current else { throw RawJSONError.invalidJSON }
            let v: RawJSONDocument.Node.Value
            switch c {
            case 0x7b: index += 1; v = .object
            case 0x5b: index += 1; v = .array
            case 0x22: v = .string(try string())
            case 0x74: try literal("true"); v = .bool(true)
            case 0x66: try literal("false"); v = .bool(false)
            case 0x6e: try literal("null"); v = .null
            case 0x2d, 0x30...0x39: v = .number(try number())
            default: throw RawJSONError.invalidJSON
            }
            let id = nodes.count
            nodes.append(.init(parent: parent, key: key, value: v))
            if c == 0x7b || c == 0x5b {
                let object = c == 0x7b
                stack.append(Frame(node: id, object: object))
                if object { pushObjectState() }
            }
        }
        mutating func literal(_ text: String) throws {
            for c in text.utf8 {
                guard current == c else { throw RawJSONError.invalidJSON }
                index += 1
            }
        }
        mutating func number() throws -> String {
            let start = index
            if current == 0x2d { index += 1 }
            if current == 0x30 { index += 1 }
            else {
                guard let c = current, (0x31...0x39).contains(c) else { throw RawJSONError.invalidJSON }
                index += 1; digits()
            }
            if current == 0x2e {
                index += 1
                guard let c = current, (0x30...0x39).contains(c) else { throw RawJSONError.invalidJSON }
                digits()
            }
            if current == 0x65 || current == 0x45 {
                index += 1
                if current == 0x2b || current == 0x2d { index += 1 }
                guard let c = current, (0x30...0x39).contains(c) else { throw RawJSONError.invalidJSON }
                digits()
            }
            return String(decoding: bytes[start..<index], as: UTF8.self)
        }
        mutating func digits() {
            while let c = current, (0x30...0x39).contains(c) { index += 1 }
        }
        mutating func hex4() throws -> UInt32 {
            var result: UInt32 = 0
            for _ in 0..<4 {
                guard let c = current else { throw RawJSONError.invalidJSON }
                let digit: UInt32
                switch c {
                case 0x30...0x39: digit = UInt32(c - 0x30)
                case 0x41...0x46: digit = UInt32(c - 0x41 + 10)
                case 0x61...0x66: digit = UInt32(c - 0x61 + 10)
                default: throw RawJSONError.invalidJSON
                }
                result = result * 16 + digit; index += 1
            }
            return result
        }
        mutating func string() throws -> String {
            index += 1
            var output: [UInt8] = []
            while let c = current {
                index += 1
                if c == 0x22 { return String(decoding: output, as: UTF8.self) }
                guard c >= 0x20 else { throw RawJSONError.invalidJSON }
                if c != 0x5c { output.append(c); continue }
                guard let escape = current else { throw RawJSONError.invalidJSON }
                index += 1
                switch escape {
                case 0x22, 0x5c, 0x2f: output.append(escape)
                case 0x62: output.append(0x08)
                case 0x66: output.append(0x0c)
                case 0x6e: output.append(0x0a)
                case 0x72: output.append(0x0d)
                case 0x74: output.append(0x09)
                case 0x75:
                    var scalar = try hex4()
                    if (0xd800...0xdbff).contains(scalar) {
                        guard current == 0x5c else { throw RawJSONError.invalidJSON }
                        index += 1
                        guard current == 0x75 else { throw RawJSONError.invalidJSON }
                        index += 1
                        let low = try hex4()
                        guard (0xdc00...0xdfff).contains(low) else { throw RawJSONError.invalidJSON }
                        scalar = 0x10000 + (scalar - 0xd800) * 0x400 + low - 0xdc00
                    }
                    guard let unicode = UnicodeScalar(scalar) else { throw RawJSONError.invalidJSON }
                    output.append(contentsOf: String(unicode).utf8)
                default: throw RawJSONError.invalidJSON
                }
            }
            throw RawJSONError.invalidJSON
        }
    }

#if DEBUG
    /// Debug-app-target measurement seam, not test-target-only; no app caller.
    static func measureForTesting(_ input: Data) throws -> (frameStride: Int, peakObjectStateCount: Int) {
        var parser = try makeParser(input)
        _ = try parser.parse()
        return (MemoryLayout<Frame>.stride, parser.peakObjectStateCount)
    }
#endif
}
