/** Plays a peer's incoming audio; a track arriving after the call was replaced is stopped. */
export function playRemoteAudio(
  peer: RTCPeerConnection,
  isCurrent: () => boolean,
  started: (track: MediaStreamTrack) => void,
) {
  const audio = new Audio();
  audio.autoplay = true;
  peer.ontrack = event => {
    if (!isCurrent()) {
      event.track.stop();
      return;
    }
    audio.srcObject = new MediaStream([event.track]);
    started(event.track);
  };
  return audio;
}
