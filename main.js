// Desktop app wrapper: opens the game in its own window.
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    title: 'Reflex',
    backgroundColor: '#0f1117',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
