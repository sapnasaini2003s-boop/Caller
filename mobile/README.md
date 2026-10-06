# Android APK

The APK is a thin shell around the hosted caller app. The phone gets an icon, a
splash screen and a full-screen app with no browser bar; the screens themselves
are served from your server.

That is the point of doing it this way: **a change you deploy reaches every
phone on the next app open.** You rebuild the APK only when the icon, the app
name or the server URL changes — not when a screen changes.

## What you need once

- **Node 18+** (you already have it)
- **JDK 17** — `java -version` must say 17 or newer. Capacitor 6 will not build
  on JDK 11.
- **Android Studio**, which brings the Android SDK with it. Install it, open it
  once, and let it finish downloading the SDK.

## Build it

```bash
cd mobile
npm install
SERVER_URL=https://caller.facultyme.com npm run add:android   # first time only
SERVER_URL=https://caller.facultyme.com npm run sync
npm run apk
```

The APK lands at:

```
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Send that file to the callers on WhatsApp. On their phone they tap it, allow
"Install unknown apps" for WhatsApp once, and it installs. No Play Store
account, no review wait.

On Windows use `gradlew.bat assembleDebug` instead of `npm run apk`, or just
press Run in Android Studio after `npm run open`.

## The URL must be HTTPS

`capacitor.config.js` refuses anything else, and Android blocks plain HTTP from
an app by default. A caller signing in over plain HTTP on office wifi is also
handing their password to anyone on that network.

For a quick test before the real domain is ready, [ngrok](https://ngrok.com)
gives you an HTTPS URL pointing at your laptop:

```bash
ngrok http 3100
SERVER_URL=https://<the-ngrok-subdomain>.ngrok-free.app npm run sync && npm run apk
```

## App icon

`npm run sync` does not generate the Android icon set. Either drop the PNGs into
`android/app/src/main/res/mipmap-*/` yourself, or let the standard tool do it:

```bash
npx @capacitor/assets generate --android \
  --iconBackgroundColor '#2C5670' --splashBackgroundColor '#2C5670'
```

It reads `assets/icon.png` and `assets/splash.png`. Copy `public/icon-512.png`
from the main app to `mobile/assets/icon.png` first.

## Signing a release build

`app-debug.apk` is fine for your own team. For a release build — needed for the
Play Store, and worth having anyway so updates install over the old version
rather than beside it — create a keystore once:

```bash
keytool -genkey -v -keystore facultyme.keystore \
  -alias facultyme -keyalg RSA -keysize 2048 -validity 10000
```

Keep that file and its password somewhere safe. **Lose it and you can never
update the app** — Android will treat a differently-signed build as a different
app, and every caller would have to uninstall and reinstall.

Then point `android/app/build.gradle` at it and run `npm run apk:release`.

## What the shell adds over a browser tab

- Home-screen icon and splash screen; no address bar
- The session cookie survives, so callers sign in once rather than daily
- `tel:` links hand off to the phone's dialler the same as in the browser
- Back button closes the current screen instead of leaving the app

## What it does not add

A webview cannot read the Android call log, so **call duration is still timed
in the app rather than taken from the phone**. If you want the real duration
recorded automatically, that needs a native app with the
`READ_CALL_LOG` permission — a separate piece of work, and Play Store review is
strict about that permission.
