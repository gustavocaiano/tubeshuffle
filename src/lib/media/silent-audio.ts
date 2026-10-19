// A top-level media element lets Chromium route media keys to the page instead
// of the cross-origin YouTube frame. This is an opt-in browser workaround.
export function createSilentAudioUrl(): string {
  const sampleRate = 8000;
  const sampleCount = sampleRate * 10;
  const buffer = new ArrayBuffer(44 + sampleCount);
  const view = new DataView(buffer);
  function writeText(offset: number, value: string) {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  }
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount, true);
  new Uint8Array(buffer, 44).fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
