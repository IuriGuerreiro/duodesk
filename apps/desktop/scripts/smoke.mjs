// Run with Electron, never node. Exercises the real app/preload and Chromium video.
import { app, BrowserWindow } from "electron";
import "../electron/main.mjs";
const deadline = setTimeout(() => {
  console.error("Smoke timeout");
  app.exit(1);
}, 30000);
void (async () => {
  try {
    await app.whenReady();
    let win;
    for (let i = 0; i < 100; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (
        win &&
        !win.webContents.isLoading() &&
        win.webContents.getURL().startsWith("duodesk://app/index.html")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const preferences = win.webContents.getLastWebPreferences();
    if (
      !preferences.sandbox ||
      !preferences.contextIsolation ||
      preferences.nodeIntegration
    )
      throw new Error("Unsafe renderer preferences");
    const result = await win.webContents.executeJavaScript(`(async () => {
    if (typeof require !== 'undefined' || typeof window.duoDesk !== 'object') throw Error('Isolation/preload failed');
    const ips = await window.duoDesk.invoke('stream_interfaces');
    if (!ips.length) throw Error('No LAN interface');
    const invitation = await window.duoDesk.invoke('stream_start', {ip: ips[0]});
    if (!invitation.url.startsWith('wss://') || invitation.fingerprint.length !== 64) throw Error('Invalid invitation');
    await window.duoDesk.invoke('stream_stop');
    const a = new RTCPeerConnection({iceServers: []});
    const b = new RTCPeerConnection({iceServers: []});
    const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=180;
    const ctx = canvas.getContext('2d');
    const timer = setInterval(() => {ctx.fillStyle = 'rgb(' + (Date.now()%255) + ',50,90)';ctx.fillRect(0,0,320,180);}, 30);
    const stream = canvas.captureStream(20);
    const candidates = [[], []];
    a.onicecandidate = e => {if(e.candidate) {if(b.remoteDescription) b.addIceCandidate(e.candidate); else candidates[0].push(e.candidate);}};
    b.onicecandidate = e => {if(e.candidate) {if(a.remoteDescription) a.addIceCandidate(e.candidate); else candidates[1].push(e.candidate);}};
    const video = document.querySelector('video');
    b.ontrack = e => {video.srcObject = new MediaStream([e.track]); video.play();};
    try {
      a.addTrack(stream.getVideoTracks()[0], stream);
      await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
      for(const c of candidates[0]) await b.addIceCandidate(c);
      await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
      for(const c of candidates[1]) await a.addIceCandidate(c);
      for(let i=0;i<100;i++) {
        const stats = await b.getStats();
        const inbound = [...stats.values()].find(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 2);
        if(inbound && video.videoWidth === 320) return {chromium:navigator.userAgent, framesDecoded:inbound.framesDecoded, width:video.videoWidth, interfaces:ips.length, signaling:invitation.url};
        await new Promise(r=>setTimeout(r,100));
      }
      throw Error('No decoded video');
    } finally {clearInterval(timer); stream.getTracks().forEach(t=>t.stop());a.close();b.close();video.srcObject=null;}
  })()`);
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
})();
