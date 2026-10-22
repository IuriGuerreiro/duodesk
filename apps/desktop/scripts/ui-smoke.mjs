// Exercise the shipped renderer controls against the real Electron host.
import { app, BrowserWindow } from "electron";
import { Host } from "../electron/host.mjs";
let sessionId;
const request = Host.prototype.request;
Host.prototype.request = async function (method, args) {
  const result = await request.call(this, method, args);
  if (method === "stream_start") sessionId = result.invitation.sessionId;
  return result;
};
import "../electron/main.mjs";
const deadline = setTimeout(() => app.exit(1), 30000);
void (async () => {
  try {
    await app.whenReady();
    let window;
    for (let i = 0; i < 100; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (
        window &&
        !window.webContents.isLoading() &&
        window.webContents.getURL().startsWith("duodesk://app/")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    window.webContents.on("console-message", (event) => {
      if (event.message === "test:pause")
        window.webContents.send("duodesk:event", {
          kind: "signal",
          signal: { v: 1, sessionId, type: "pause" },
        });
    });
    const result = await window.webContents.executeJavaScript(
      `(async () => {
    const wait = async (predicate, message) => {
      for (let i=0;i<100;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,50)); }
      throw Error(message);
    };
    const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
    await wait(()=>[...document.querySelector('select')?.options ?? []].some(o=>o.value && !o.disabled), 'Address discovery failed');
    const choose = document.querySelector('select');
    if (choose.value || !button('Create connection').disabled) throw Error('Address must be selected explicitly');
    choose.value = [...choose.options].find(o=>o.value && !o.disabled).value;
    choose.dispatchEvent(new Event('change', {bubbles:true}));
    await wait(()=>!button('Create connection').disabled, 'Address selection failed');
    const Peer = window.RTCPeerConnection;
    let peer;
    window.RTCPeerConnection = class extends Peer {
      constructor(config) { super(config); peer = this; }
    };
    button('Create connection').click();
    await wait(()=>document.querySelector('[aria-label="Six-digit verification code"]'), 'Pairing code did not appear');
    const code = document.querySelector('[aria-label="Six-digit verification code"]');
    if (!code || !/^[0-9]{6}$/.test(code.textContent)) throw Error('Pairing code missing');
    const qr = document.querySelector('.pair-card .qr-frame svg');
    if (!qr) throw Error('Six-digit pairing QR missing');
    if (!document.querySelector('select').disabled) throw Error('Address selection should be disabled during active session');
    if (button('Create connection')) throw Error('Create connection button should be hidden during active session');
    if (document.querySelector('textarea') || document.body.innerText.includes('Manual invitation')) throw Error('Legacy invitation input returned');
    if (!document.querySelector('video')) throw Error('Video stage missing');
    const video = document.querySelector('video');
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    const draw = setInterval(() => context.fillRect(0, 0, 32, 32), 30);
    const media = canvas.captureStream(30);
    const play = video.play.bind(video);
    let attempts = 0;
    video.play = () => {
      attempts++;
      return attempts <= 2 ? Promise.reject(new DOMException('Playback blocked', 'NotAllowedError')) : play();
    };
    peer.ontrack({track: media.getVideoTracks()[0]});
    Object.defineProperty(peer, 'connectionState', {value: 'connected'});
    peer.onconnectionstatechange();
    await wait(()=>button('Play video') && document.querySelector('[role="alert"]'), 'Playback recovery missing in live view');
    button('Play video').click();
    await wait(()=>!button('Play video') && !video.paused, 'Manual playback retry failed');
    const firstPeer = peer;
    console.info('test:pause');
    await wait(()=>peer !== firstPeer && document.querySelector('.phase-connecting'), 'Pause must create a fresh receiver and retain the paired session');
    if (document.querySelector('.pair-card') || button('Create connection')) throw Error('Pause lost pairing');
    peer.ontrack({track: media.getVideoTracks()[0]});
    Object.defineProperty(peer, 'connectionState', {value: 'connected'});
    peer.onconnectionstatechange();
    await wait(()=>document.querySelector('.phase-live') && !video.paused, 'Receiver did not resume');
    window.RTCPeerConnection = Peer;
    delete video.play;
    clearInterval(draw);
    media.getTracks().forEach(track=>track.stop());
    button('Stop session').click();
    await wait(()=>!document.querySelector('.pair-card') && document.querySelector('select') && !document.querySelector('select').disabled, 'Stop did not clear pairing card and restore address select');
    const select = document.querySelector('select');
    if (!document.querySelector('[role="status"]').textContent.includes('Session ended')) throw Error('Stopped status missing');
    if (document.querySelector('.app-header, .page-heading, .preview-notice, .diagnostics, footer')) throw Error('Removed UI returned');
    for (const name of ['camera', 'microphone']) {
      const permission = await navigator.permissions.query({name});
      if (permission.state !== 'denied') throw Error(name + ' permission must remain denied');
    }
    button('Fullscreen').click();
    await wait(()=>document.fullscreenElement?.classList.contains('receiver-panel'), 'Fullscreen did not open receiver: ' + document.querySelector('[role=alert]')?.textContent);
    await wait(()=>button('Exit fullscreen'), 'Fullscreen button did not update');
    button('Exit fullscreen').click();
    await wait(()=>!document.fullscreenElement, 'Fullscreen did not exit');
    return {passed:true,addressOptions:select.options.length,pairingQrCard:true,stopped:true,videoStage:true,playbackRecovery:true,pauseResume:true,fullscreen:true};
  })()`,
      true,
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
})();
