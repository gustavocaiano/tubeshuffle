import {
  classifyEnergyTrack,
  getEnergyBucketOrder,
  type EnergyBucket,
  type EnergyTrackInput,
  type TrackEnergyProfile,
} from "@/lib/shuffle/energy-classifier";

type BucketQueues<T> = Record<EnergyBucket, T[]>;

const FULL_WAVE_GROUP_SIZE = 3;
const MID_WAVE_GROUP_SIZE = 2;

function emptyQueues<T>(): BucketQueues<T> {
  return {
    hype: [],
    upbeat: [],
    steady: [],
    chill: [],
    melancholy: [],
    unknown: [],
  };
}

function bucketIndex(bucket: EnergyBucket): number {
  return getEnergyBucketOrder().indexOf(bucket as Exclude<EnergyBucket, "unknown">);
}

function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function nearestAvailableBucket<T>(
  desired: EnergyBucket,
  queues: BucketQueues<T>
): EnergyBucket | null {
  const available = getEnergyBucketOrder().filter((bucket) => queues[bucket].length > 0);

  if (desired === "unknown") {
    return available[0] ?? (queues.unknown.length > 0 ? "unknown" : null);
  }

  if (queues[desired].length > 0) {
    return desired;
  }

  if (queues.unknown.length > 0 && (desired === "steady" || desired === "chill")) {
    return "unknown";
  }

  if (available.length === 0) {
    return queues.unknown.length > 0 ? "unknown" : null;
  }

  const desiredIndex = bucketIndex(desired);
  let bestBucket = available[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestCount = -1;

  for (const bucket of available) {
    const distance = Math.abs(bucketIndex(bucket) - desiredIndex);
    const count = queues[bucket].length;
    if (distance < bestDistance || (distance === bestDistance && count > bestCount)) {
      bestBucket = bucket;
      bestDistance = distance;
      bestCount = count;
    }
  }

  return bestBucket;
}

function pickStartBucket(profiles: TrackEnergyProfile[]): Exclude<EnergyBucket, "unknown"> {
  const tallies = new Map<Exclude<EnergyBucket, "unknown">, { score: number; firstIndex: number }>();

  profiles.forEach((profile, index) => {
    if (profile.bucket === "unknown") return;
    const current = tallies.get(profile.bucket) ?? { score: 0, firstIndex: index };
    current.score += profile.score * (0.5 + profile.confidence / 2);
    current.firstIndex = Math.min(current.firstIndex, index);
    tallies.set(profile.bucket, current);
  });

  let bestBucket: Exclude<EnergyBucket, "unknown"> = "steady";
  let bestScore = -1;
  let bestFirstIndex = Number.POSITIVE_INFINITY;

  for (const bucket of getEnergyBucketOrder()) {
    const tally = tallies.get(bucket);
    const score = tally?.score ?? 0;
    const firstIndex = tally?.firstIndex ?? Number.POSITIVE_INFINITY;
    if (score > bestScore || (score === bestScore && firstIndex < bestFirstIndex)) {
      bestBucket = bucket;
      bestScore = score;
      bestFirstIndex = firstIndex;
    }
  }

  return bestBucket;
}

function buildWaveCycle(startIndex: number, maxIndex: number): number[] {
  const firstDirection = startIndex >= Math.floor(maxIndex / 2) ? -1 : 1;
  const cycle = [startIndex];
  let current = startIndex;
  let direction = firstDirection;

  while (cycle.length < (maxIndex + 1) * 2) {
    const next = current + direction;
    if (next < 0 || next > maxIndex) {
      direction *= -1;
      continue;
    }

    current = next;
    cycle.push(current);
  }

  return cycle;
}

function buildWave(length: number, startBucket: Exclude<EnergyBucket, "unknown">): EnergyBucket[] {
  const ladder = getEnergyBucketOrder();
  const startIndex = bucketIndex(startBucket);
  const cycle = buildWaveCycle(startIndex, ladder.length - 1);
  const groupSize =
    length >= 24 ? FULL_WAVE_GROUP_SIZE : length >= 10 ? MID_WAVE_GROUP_SIZE : 1;

  const wave: EnergyBucket[] = [];
  let cycleIndex = 0;
  while (wave.length < length) {
    const bucket = ladder[cycle[cycleIndex % cycle.length]];
    for (let i = 0; i < groupSize && wave.length < length; i++) {
      wave.push(bucket);
    }
    cycleIndex += 1;
  }

  return wave;
}

export function smartEnergyShuffle<T extends EnergyTrackInput>(videos: T[]): T[] {
  if (videos.length <= 1) {
    return [...videos];
  }

  const profiles = videos.map((video, index) => ({
    ...classifyEnergyTrack(video),
    index,
    video,
  }));

  const queues = emptyQueues<typeof videos[number]>();
  for (const entry of profiles) {
    queues[entry.bucket].push(entry.video);
  }

  for (const bucket of ["hype", "upbeat", "steady", "chill", "melancholy", "unknown"] as const) {
    queues[bucket] = shuffleArray(queues[bucket]);
  }

  const startBucket = pickStartBucket(profiles);
  const desiredBuckets = buildWave(videos.length, startBucket);

  const ordered: T[] = [];
  for (const desiredBucket of desiredBuckets) {
    const bucket = nearestAvailableBucket(desiredBucket, queues);
    if (!bucket) continue;
    const next = queues[bucket].shift();
    if (next) ordered.push(next);
  }

  for (const bucket of ["hype", "upbeat", "steady", "chill", "melancholy", "unknown"] as const) {
    ordered.push(...(queues[bucket] as T[]));
  }

  return ordered;
}
