import './style.css';

const arrow = '<span aria-hidden="true">↗</span>';
const mark = '<span class="brand-mark" aria-hidden="true"><i></i><i></i></span>';
const icons = { desktop: '▱', tablet: '▯', phone: '▯' };

document.querySelector('#app').innerHTML = `
  <header class="header wrap">
    <a class="brand" href="#" aria-label="DuoDesk home">${mark}duodesk</a>
    <nav aria-label="Main navigation"><a href="#possibilities">The possibilities</a><a href="#how-it-works">How it works</a><a href="#questions">FAQs</a></nav>
    <a class="button nav-button" href="#development">Meet your new setup ${arrow}</a>
  </header>
  <main>
    <section class="hero wrap">
      <div class="eyebrow"><span class="status-dot"></span> LESS FRICTION. MORE CONNECTION.</div>
      <h1>Your devices.<br>Better <span class="together">together.<svg viewBox="0 0 570 30" aria-hidden="true"><path d="M7 22 Q250 0 558 12"/></svg></span></h1>
      <p class="hero-copy">Your iPad. Your PC. Your phone. One happy workspace. <br>Share screens and take control, right on your local network.</p>
      <a class="button primary" href="#possibilities">Find your flow <span aria-hidden="true">↓</span></a>
      <p class="hero-note">Built for the devices you already love.</p>
      <div class="demo" aria-label="Interactive screen sharing concept">
        <div class="demo-heading"><span><span class="status-dot"></span> YOUR DESK, CONNECTED</span><span class="demo-label">A LITTLE PREVIEW OF WHAT’S COMING</span></div>
        <div class="device-scene">
          <div class="connection-line line-one"></div><div class="connection-line line-two"></div>
          <div class="device tablet"><div class="camera"></div><div class="device-screen artwork"><span class="art-tag">A little room<br>to think.</span><div class="orb orb-one"></div><div class="orb orb-two"></div><div class="art-caption">IDEAS LOOK BETTER WITH SPACE.</div></div><span class="device-name">${icons.tablet} <span id="source-name">Your iPad</span><span class="device-role">SHARING</span></span></div>
          <span class="connection-badge" aria-hidden="true">⇄</span>
          <div class="device monitor"><div class="monitor-top"><span>${mark} DuoDesk</span><span>•••</span></div><div class="monitor-content"><aside><span class="sidebar-icon">▦</span><span class="sidebar-icon active">▱</span><span class="sidebar-icon">⚙</span></aside><div class="stream-content"><div class="stream-title"><span id="stream-name">iPad screen</span><span><i class="status-dot"></i> Local connection</span></div><div class="artwork mirror"><span class="art-tag">A little room<br>to think.</span><div class="orb orb-one"></div><div class="orb orb-two"></div><div class="art-caption">IDEAS LOOK BETTER WITH SPACE.</div></div><div class="stream-controls"><span>↖ <span id="control-label">Screen sharing</span></span><span>⛶</span></div></div></div><span class="device-name">${icons.desktop} <span id="target-name">Your Windows PC</span><span class="device-role">RECEIVING</span></span><div class="monitor-foot"></div></div>
          <div class="local-pill"><span class="wifi" aria-hidden="true">◉</span> Same Wi-Fi. Closer together.</div>
        </div>
        <div class="demo-bottom"><span>GOOD CONNECTIONS GO BOTH WAYS.</span><button class="swap-button" type="button">Switch direction <span aria-hidden="true">⇄</span></button></div>
      </div>
      <div class="platforms"><span>DIFFERENT SCREENS. SAME TEAM.</span><div><span>⊞ Windows</span><span>◧ iPad</span><span>◧ iPhone</span><span>♧ Android</span></div><small>Planned platform support</small></div>
    </section>
    <section class="possibilities wrap" id="possibilities">
      <div class="section-intro"><div><p class="eyebrow">A LITTLE LESS BACK AND FORTH</p><h2>Make room for<br>your kind of work.</h2></div><p>Some things are better on a bigger screen.<br>Some things are better from the sofa.<br>Your setup should keep up.</p></div>
      <div class="feature-grid"><article class="feature feature-blue"><div class="mini-share"><div class="mini-tablet"><div class="mini-art"></div></div><span>↗</span><div class="mini-desktop"><div class="mini-art"></div></div></div><p class="feature-kicker">SHARE YOUR SCREEN</p><h3>Small screen.<br>Bigger possibilities.</h3><p>Bring your iPad or phone to your PC screen. Give your ideas, photos, and work a little more space.</p></article><article class="feature feature-peach"><div class="mini-control"><div class="control-window"><span>YOUR DESKTOP, WITHIN REACH</span><div class="mock-lines"></div><div class="cursor">↖<span>You</span></div></div><div class="mini-phone"><span>↖</span></div></div><p class="feature-kicker">TAKE CONTROL</p><h3>Your desk.<br>Wherever you sit.</h3><p>We’re building remote control for supported devices, so your mouse and keyboard can go further.</p></article><article class="feature feature-green"><div class="network-art"><span>▱</span><i></i><span>⌁</span><i></i><span>▯</span></div><p class="feature-kicker">KEEP IT LOCAL</p><h3>Across the room.<br>On your network.</h3><p>A direct connection between your devices. Designed around your local network, close to home.</p></article></div>
    </section>
    <section class="how wrap" id="how-it-works"><div><p class="eyebrow">LESS SETUP. MORE DOING.</p><h2>A familiar network.<br>A whole new flow.</h2><p>We’re making the space between your screens<br>feel a little smaller.</p></div><ol><li><span>01</span><div><h3>Get on the same network</h3><p>Connect your devices to your home or office Wi-Fi.</p></div></li><li><span>02</span><div><h3>Pair your devices</h3><p>Choose the device you want to connect with and approve the connection.</p></div></li><li><span>03</span><div><h3>Make yourself at home</h3><p>Share a screen or use supported remote controls. You choose the direction.</p></div></li></ol></section>
    <section class="questions wrap" id="questions"><div><p class="eyebrow">A FEW GOOD QUESTIONS</p><h2>Let’s connect<br>the dots.</h2></div><div class="faq-list"><details><summary>Can I use DuoDesk today?</summary><p>Not yet. DuoDesk is in development. This page shows the direction we’re building toward, and the device preview is an illustration.</p></details><details><summary>Which devices will it work with?</summary><p>We’re working toward Windows, iPad, iPhone, and Android support. Features and availability will vary by platform.</p></details><details><summary>Can I control my iPad from my PC?</summary><p>iPad screen sharing is a goal. Full remote control depends on operating system permissions and may not be available on iPad or iPhone. We’ll publish supported controls as they’re verified.</p></details><details><summary>Do my devices need the same Wi-Fi?</summary><p>DuoDesk is being designed for devices on the same reachable local network. Guest networks or network isolation may prevent a connection.</p></details></div></section>
    <section class="closing wrap" id="development"><span class="eyebrow"><span class="status-dot"></span> CURRENTLY IN THE MAKING</span><h2>A good connection<br>changes everything.</h2><p>We’re building DuoDesk, one screen at a time.<br>Your next workspace is taking shape.</p><a class="button" href="#how-it-works">See how it will work ${arrow}</a><span class="closing-art" aria-hidden="true">${mark}</span></section>
  </main>
  <footer class="wrap"><a class="brand" href="#">${mark}duodesk</a><p>A little closer. A lot more possible.</p><span>© ${new Date().getFullYear()} DuoDesk</span></footer>
`;

let reversed = false;
document.querySelector('.swap-button').addEventListener('click', () => {
  reversed = !reversed;
  document.querySelector('#source-name').textContent = reversed ? 'Your Windows PC' : 'Your iPad';
  document.querySelector('#target-name').textContent = reversed ? 'Your iPad' : 'Your Windows PC';
  document.querySelector('#stream-name').textContent = reversed ? 'Windows screen' : 'iPad screen';
  document.querySelector('.demo').classList.toggle('reversed', reversed);
});
