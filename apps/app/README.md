# rdsh-app

Flutter app (Android / iOS) — milestone M5 (shifted from M4 on 2026-08-23).

Scope (Q7, decided): first version is a **pure WebView shell** loading the
rdsh-portal H5 (login, host list, DSH UI). Flutter side only manages login
state (Keychain/Keystore) and token injection into the WebView. No native
push, no native file management in the first version.

Skeleton — implementation starts at M5.
