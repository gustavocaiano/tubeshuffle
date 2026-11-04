import SwiftUI

struct SampleLibraryView: View {
    @Environment(\.dismiss) private var dismiss
    private let model = SampleLibraryModel()
    @State private var selected: PlaylistID? = PlaylistID("sample-mornings")

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Sample library").font(.title2.weight(.semibold))
                    Text("Made-up playlists for preview only. These are not your playlists and do not affect playback.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer(minLength: 16)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(20)
            Divider()
            HStack(spacing: 0) {
                List(selection: $selected) {
                    Section("Sample playlists") {
                        ForEach(model.snapshot.playlists, id: \.id) { playlist in
                            Label(playlist.title, systemImage: "music.note.list")
                                .tag(playlist.id)
                        }
                    }
                }
                .listStyle(.sidebar)
                .frame(minWidth: 175, idealWidth: 200, maxWidth: 220)
                Divider()
                if let selected, let playlist = model.snapshot.playlists.first(where: { $0.id == selected }) {
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("SELECTED SAMPLE PLAYLIST").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(playlist.title).font(.title2.weight(.semibold))
                            Text("\(model.occurrences(for: selected).count) sample items · watched status is illustrative")
                                .font(.callout).foregroundStyle(.secondary)
                        }.padding(20)
                        Divider()
                        List {
                            ForEach(model.occurrences(for: selected), id: \.id) { item in
                                HStack(spacing: 12) {
                                    Text("\(item.position + 1)").monospacedDigit().foregroundStyle(.secondary)
                                        .frame(width: 24, alignment: .trailing)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(item.title).fontWeight(.medium)
                                        Text(item.channelTitle).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(model.isWatched(item) ? "Watched" : "Not watched")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 5)
                                .accessibilityElement(children: .combine)
                            }
                        }.listStyle(.plain)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    Text("Select a sample playlist")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 650, minHeight: 440)
    }
}
