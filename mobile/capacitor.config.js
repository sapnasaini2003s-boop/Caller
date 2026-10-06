/**
 * The APK is a thin shell around the hosted caller app.
 *
 * Because `server.url` points at the live site, a change you deploy to the
 * server reaches every phone on the next app open — no rebuild, no reinstall,
 * no asking ten callers to update. The APK only needs rebuilding when the
 * icon, the app name or the server URL itself changes.
 *
 * Set the URL before building:
 *
 *   SERVER_URL=https://caller.facultyme.com npm run sync
 *
 * It must be HTTPS. Android blocks plain HTTP by default, and a caller's
 * password would be readable on the office wifi besides.
 */
const SERVER_URL = process.env.SERVER_URL || 'https://caller.facultyme.com';

if (!/^https:\/\//.test(SERVER_URL)) {
  throw new Error(`SERVER_URL must start with https:// — got "${SERVER_URL}"`);
}

module.exports = {
  appId: 'com.facultyme.caller',
  appName: 'FacultyMe Caller',
  webDir: 'www',

  server: {
    url: SERVER_URL,
    cleartext: false,
    // Everything else opens in the phone's browser rather than inside the app,
    // so a stray link cannot leave a caller stranded in a webview.
    allowNavigation: [new URL(SERVER_URL).host],
  },

  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 900,
      backgroundColor: '#2C5670',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#2C5670',
    },
  },
};
