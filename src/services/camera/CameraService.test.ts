/**
 * CameraService concurrency tests — the media-API race that produced the
 * browser error "The play() request was interrupted by a new load request"
 * when two start() attempts overlapped (double-click on Start, rapid
 * "Try camera again" taps, or quitting mid-start).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraService } from "./CameraService";

const ABORT = new DOMException("The play() request was interrupted by a new load request", "AbortError");

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeStream(label: string) {
  const tracks = [{ kind: "video", label, stop: vi.fn() }];
  return { label, active: true, getTracks: () => tracks, tracks };
}

function makeVideo() {
  const settles: Array<{ reject: (e: unknown) => void; resolve: () => void }> = [];
  const el = {
    srcObject: null as MediaStream | null,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    play: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settles.push({ reject, resolve });
        })
    ),
  };
  return {
    el,
    failPlay: (i: number, err: unknown) => settles[i]?.reject(err),
    finishPlay: (i: number) => settles[i]?.resolve(),
  };
}

function stubUserMediaSequence(promises: Array<Promise<MediaStream>>) {
  const fn = vi.fn();
  promises.forEach((p) => fn.mockImplementationOnce(() => p));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: fn } });
}

function stubGetUserMedia(promise: Promise<MediaStream>) {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => promise) } });
}

afterEach(() => vi.unstubAllGlobals());

describe("CameraService start() — overlapping attempts", () => {
  it("a single clean start attaches the stream and plays", async () => {
    const gum = deferred<MediaStream>();
    const { el, finishPlay } = makeVideo();
    const svc = new CameraService();
    stubGetUserMedia(gum.promise);

    const started = svc.start(el as unknown as HTMLVideoElement);
    const s = makeStream("ok");
    gum.resolve(s as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.srcObject).toBe(s as unknown as MediaStream);
    expect(el.play).toHaveBeenCalledTimes(1);
    finishPlay(0);
    await expect(started).resolves.toBeUndefined();
  });

  it("a newer start supersedes an earlier one still awaiting permission", async () => {
    const gumA = deferred<MediaStream>();
    const gumB = deferred<MediaStream>();
    stubUserMediaSequence([gumA.promise, gumB.promise]);
    const { el, finishPlay } = makeVideo();
    const svc = new CameraService();

    const first = svc.start(el as unknown as HTMLVideoElement);
    const second = svc.start(el as unknown as HTMLVideoElement);

    // A resolves last — it must have been superseded before attaching.
    const sA = makeStream("A");
    gumA.resolve(sA as unknown as MediaStream);
    await expect(first).resolves.toBeUndefined();
    expect(sA.tracks[0].stop).toHaveBeenCalledTimes(1); // released, never attached
    expect(el.srcObject).toBeNull();

    const sB = makeStream("B");
    gumB.resolve(sB as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.srcObject).toBe(sB as unknown as MediaStream);
    expect(sB.tracks[0].stop).not.toHaveBeenCalled();
    // Only the winner ever reaches play(), so it is play-call index 0.
    finishPlay(0);
    await expect(second).resolves.toBeUndefined();
  });

  it("swallows the play() interruption caused by a newer attempt replacing srcObject", async () => {
    const gumA = deferred<MediaStream>();
    const gumB = deferred<MediaStream>();
    stubUserMediaSequence([gumA.promise, gumB.promise]);
    const { el, failPlay } = makeVideo();
    const svc = new CameraService();

    // First attempt attaches and starts play().
    const first = svc.start(el as unknown as HTMLVideoElement);
    const sA = makeStream("A");
    gumA.resolve(sA as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.srcObject).toBe(sA as unknown as MediaStream);

    // Second attempt begins while the first's play() is still pending.
    void svc.start(el as unknown as HTMLVideoElement); // stays pending — B owns the element now
    const sB = makeStream("B");
    gumB.resolve(sB as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.srcObject).toBe(sB as unknown as MediaStream);
    expect(el.play).toHaveBeenCalledTimes(2);

    // Chrome rejects the superseded play() — must not surface as a failure.
    failPlay(0, ABORT);
    await expect(first).resolves.toBeUndefined(); // superseded, not an error
    expect(sA.tracks[0].stop).toHaveBeenCalled(); // released by the loser
    expect(sB.tracks[0].stop).not.toHaveBeenCalled();

    // (second's own play() stays pending in real life until frames flow)
  });

  it("stop() invalidates a start still awaiting permission (quit mid-start)", async () => {
    const gum = deferred<MediaStream>();
    stubGetUserMedia(gum.promise);
    const { el } = makeVideo();
    const svc = new CameraService();

    const pending = svc.start(el as unknown as HTMLVideoElement);
    svc.stop(el as unknown as HTMLVideoElement); // e.g. user quit while the prompt was up

    const late = makeStream("late");
    gum.resolve(late as unknown as MediaStream);
    await expect(pending).resolves.toBeUndefined();
    expect(late.tracks[0].stop).toHaveBeenCalledTimes(1); // released, not attached
    expect(el.srcObject).toBeNull();
    expect(el.play).not.toHaveBeenCalled();
  });

  it("rejects when getUserMedia is unavailable", async () => {
    const svc = new CameraService();
    vi.stubGlobal("navigator", {});
    await expect(
      svc.start({} as unknown as HTMLVideoElement)
    ).rejects.toThrow("Camera access is not supported in this browser.");
  });
});