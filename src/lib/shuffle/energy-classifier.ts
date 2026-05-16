export type EnergyBucket =
  | "hype"
  | "upbeat"
  | "steady"
  | "chill"
  | "melancholy"
  | "unknown";

export interface EnergyTrackInput {
  title: string;
  channelTitle: string;
  description?: string;
  tags?: readonly string[];
  categoryId?: string;
  duration?: number;
}

export interface TrackEnergyProfile {
  bucket: EnergyBucket;
  score: number;
  confidence: number;
  signals: string[];
}

type BucketScoreMap = Record<Exclude<EnergyBucket, "unknown">, number>;

const BUCKET_ORDER: Exclude<EnergyBucket, "unknown">[] = [
  "melancholy",
  "chill",
  "steady",
  "upbeat",
  "hype",
];

const FIELD_WEIGHTS = {
  title: 1.6,
  channelTitle: 1.1,
  description: 0.85,
  tags: 1.05,
} as const;

const RULES: Array<{
  bucket: Exclude<EnergyBucket, "unknown">;
  terms: string[];
}> = [
  {
    bucket: "hype",
    terms: [
      "hype",
      "hard",
      "aggressive",
      "rage",
      "banger",
      "club",
      "festival",
      "drill",
      "phonk",
      "nightcore",
      "sped up",
      "speed up",
      "fast",
      "pump",
      "pump up",
      "trap",
      "hyper",
    ],
  },
  {
    bucket: "upbeat",
    terms: [
      "upbeat",
      "happy",
      "dance",
      "party",
      "energetic",
      "uplift",
      "uplifting",
      "summer",
      "joy",
      "fun",
      "remix",
      "mix",
      "pop",
      "edm",
      "bounce",
      "groove",
      "alegre",
      "animada",
      "animado",
      "feliz",
      "danca",
      "festa",
    ],
  },
  {
    bucket: "steady",
    terms: [
      "steady",
      "groove",
      "anthem",
      "live",
      "version",
      "official",
      "audio",
      "performance",
      "rock",
      "indie",
      "synth",
      "radio edit",
      "original",
      "session",
      "classic",
    ],
  },
  {
    bucket: "chill",
    terms: [
      "chill",
      "lofi",
      "lo-fi",
      "calm",
      "calma",
      "relax",
      "relaxed",
      "ambient",
      "soft",
      "acoustic",
      "study",
      "sleep",
      "downtempo",
      "instrumental",
      "smooth",
      "gentle",
      "mellow",
      "quiet",
    ],
  },
  {
    bucket: "melancholy",
    terms: [
      "sad",
      "sadness",
      "triste",
      "melancholy",
      "melancolic",
      "heartbreak",
      "lonely",
      "alone",
      "slow",
      "slowed",
      "slow version",
      "emotional",
      "nostalgic",
      "nostalgia",
      "blue",
      "cry",
      "broken",
      "minor",
      "down",
    ],
  },
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function emptyBucketScores(): BucketScoreMap {
  return {
    hype: 0,
    upbeat: 0,
    steady: 0,
    chill: 0,
    melancholy: 0,
  };
}

function scanField(
  scores: BucketScoreMap,
  signals: string[],
  fieldName: keyof typeof FIELD_WEIGHTS,
  value: string | undefined
): void {
  if (!value) return;
  const normalized = normalize(value);

  for (const rule of RULES) {
    for (const term of rule.terms) {
      const normalizedTerm = normalize(term);
      if (!normalized.includes(normalizedTerm)) continue;

      scores[rule.bucket] += FIELD_WEIGHTS[fieldName];
      signals.push(`${fieldName}:${rule.bucket}:${normalizedTerm}`);
      break;
    }
  }
}

function applyDurationSignal(
  scores: BucketScoreMap,
  signals: string[],
  duration?: number
): void {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return;
  }

  if (duration <= 180) {
    scores.hype += 0.35;
    scores.upbeat += 0.55;
    signals.push("duration:short");
    return;
  }

  if (duration <= 270) {
    scores.upbeat += 0.3;
    scores.steady += 0.4;
    signals.push("duration:mid");
    return;
  }

  if (duration <= 420) {
    scores.steady += 0.25;
    scores.chill += 0.5;
    signals.push("duration:long");
    return;
  }

  scores.chill += 0.35;
  scores.melancholy += 0.55;
  signals.push("duration:very-long");
}

function rankBuckets(scores: BucketScoreMap): Array<[Exclude<EnergyBucket, "unknown">, number]> {
  return BUCKET_ORDER.map(
    (bucket): [Exclude<EnergyBucket, "unknown">, number] => [bucket, scores[bucket]]
  ).sort(
    (a, b) => b[1] - a[1] || BUCKET_ORDER.indexOf(a[0]) - BUCKET_ORDER.indexOf(b[0])
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function classifyEnergyTrack(input: EnergyTrackInput): TrackEnergyProfile {
  const scores = emptyBucketScores();
  const signals: string[] = [];

  scanField(scores, signals, "title", input.title);
  scanField(scores, signals, "channelTitle", input.channelTitle);
  scanField(scores, signals, "description", input.description);
  scanField(scores, signals, "tags", input.tags?.join(" "));
  applyDurationSignal(scores, signals, input.duration);

  const categoryId = input.categoryId?.trim();
  if (categoryId) {
    signals.push(`category:${categoryId}`);
  }

  const ranked = rankBuckets(scores);
  const [topBucket, topScore] = ranked[0] ?? ["steady", 0];
  const secondScore = ranked[1]?.[1] ?? 0;

  const musicCategoryBoost = categoryId === "10" ? 0.2 : 0;
  const topWithBoost = topScore + musicCategoryBoost;
  const confidence = clamp(
    topWithBoost / (topWithBoost + secondScore + 1.1),
    0,
    1
  );

  if (topScore < 0.9) {
    return {
      bucket: "unknown",
      score: Math.round(topWithBoost * 12),
      confidence,
      signals,
    };
  }

  return {
    bucket: topBucket,
    score: Math.round(clamp(topWithBoost * 18, 0, 100)),
    confidence,
    signals,
  };
}

export function getEnergyBucketOrder(): Exclude<EnergyBucket, "unknown">[] {
  return [...BUCKET_ORDER];
}
