// Desktop app wrapper: opens the app in its own window.
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 480,
    title: 'Model AI',
    backgroundColor: '#1b2233',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
