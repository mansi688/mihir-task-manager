#!/usr/bin/env bash
# Builds MIHIR-Tasks.apk — no Android Studio or Gradle needed.
#
#   ./android/build-apk.sh                                     # built for https://mihir-task-manager.onrender.com
#   ./android/build-apk.sh https://other-site.onrender.com     # a different site address
#   VERSION_CODE=3 VERSION_NAME=1.2 ./android/build-apk.sh     # bump the version for an update
#
# Needs (Ubuntu/Debian):  sudo apt install openjdk-17-jdk-headless aapt dalvik-exchange zipalign apksigner android-sdk-platform-23
# Always sign with the SAME mihir-tasks.keystore — Android only installs an update over an existing
# app if both were signed with the same key. Keep a backup of that file.
set -euo pipefail
cd "$(dirname "$0")"
SITE_URL="${1:-https://mihir-task-manager.onrender.com}"
ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
KEYSTORE="${KEYSTORE:-mihir-tasks.keystore}"
KS_PASS="${KS_PASS:-mihirtasks2026}"
VERSION_CODE="${VERSION_CODE:-}"
VERSION_NAME="${VERSION_NAME:-}"
if [ -n "$SITE_URL" ] && [[ "$SITE_URL" != https://* ]]; then echo "Site address must start with https://"; exit 1; fi

rm -rf build && mkdir -p build/gen build/classes
cp -r res build/res
SITE_URL="${SITE_URL%/}"
sed -i "s#__SITE_URL__#${SITE_URL}#" build/res/values/strings.xml
cp AndroidManifest.xml build/AndroidManifest.xml
[ -n "$VERSION_CODE" ] && sed -i "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"${VERSION_CODE}\"/" build/AndroidManifest.xml
[ -n "$VERSION_NAME" ] && sed -i "s/android:versionName=\"[^\"]*\"/android:versionName=\"${VERSION_NAME}\"/" build/AndroidManifest.xml

echo "1/6 resources";  aapt package -f -m -J build/gen -M build/AndroidManifest.xml -S build/res -I "$ANDROID_JAR"
echo "2/6 compile";    javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -Xlint:-options -d build/classes build/gen/com/mihir/taskmanager/R.java src/com/mihir/taskmanager/*.java
echo "3/6 dex";        dalvik-exchange --dex --min-sdk-version=23 --output=build/classes.dex build/classes
echo "4/6 package";    aapt package -f -M build/AndroidManifest.xml -S build/res -I "$ANDROID_JAR" -F build/app.unsigned.apk
                       (cd build && aapt add app.unsigned.apk classes.dex >/dev/null)
echo "5/6 align";      zipalign -f -p 4 build/app.unsigned.apk build/app.aligned.apk
if [ ! -f "$KEYSTORE" ]; then
  echo "    (creating signing key $KEYSTORE — keep a backup!)"
  keytool -genkeypair -keystore "$KEYSTORE" -alias mihir -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" -dname "CN=MIHIR Tasks, O=MIHIR, C=IN" >/dev/null 2>&1
fi
echo "6/6 sign";       apksigner sign --ks "$KEYSTORE" --ks-key-alias mihir --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out MIHIR-Tasks.apk build/app.aligned.apk
apksigner verify MIHIR-Tasks.apk && echo "Built: android/MIHIR-Tasks.apk  (site: ${SITE_URL:-asked on first launch})"
