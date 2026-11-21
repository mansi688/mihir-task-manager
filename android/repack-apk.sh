#!/usr/bin/env bash
# Rebuilds MIHIR-Tasks.apk after a change to the Java code ONLY (src/), when no API 34 android.jar is at hand.
# It compiles the Java against Ubuntu's Android 6 android.jar (apt install android-sdk-platform-23), and reuses the
# already-compiled manifest and resources of the current MIHIR-Tasks.apk. Android 8+ APIs are called by reflection
# in the code, so this works. Changes to res/ or AndroidManifest.xml still need build-apk.sh with an API 34 jar.
#   VERSION_CODE=8 ./android/repack-apk.sh      # versionCode must go up for phones to take it as an update
# Needs: openjdk-17-jdk-headless aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 python3
set -euo pipefail
cd "$(dirname "$0")"
J=/usr/lib/android-sdk/platforms/android-23/android.jar
KS_PASS="${KS_PASS:-mihirtasks2026}"
B=$(mktemp -d)
cp -r res "$B/res"; sed 's/android:foregroundServiceType="[^"]*"//' AndroidManifest.xml > "$B/AndroidManifest.xml"
mkdir -p "$B/gen" "$B/classes"
aapt package -f -m -J "$B/gen" -M "$B/AndroidManifest.xml" -S "$B/res" -I "$J"
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$J" -Xlint:-options -d "$B/classes" "$B/gen/com/mihir/taskmanager/R.java" src/com/mihir/taskmanager/*.java
dalvik-exchange --dex --min-sdk-version=23 --output="$B/classes.dex" "$B/classes"
cp MIHIR-Tasks.apk "$B/un.apk"; zip -q -d "$B/un.apk" 'META-INF/*' classes.dex; zip -q -j "$B/un.apk" "$B/classes.dex"
if [ -n "${VERSION_CODE:-}" ]; then
  unzip -p "$B/un.apk" AndroidManifest.xml > "$B/m.xml"
  python3 - "$B/m.xml" "$VERSION_CODE" <<'PY'
import struct, sys
p, code = sys.argv[1], int(sys.argv[2]); d = bytearray(open(p, 'rb').read())
# attribute android:versionCode (0x0101021b) is the 'versionCode' string; find the int attribute that names it
cnt, _, flags, strstart, _ = struct.unpack_from('<IIIII', d, 16)
offs = [struct.unpack_from('<I', d, 36 + 4 * i)[0] for i in range(cnt)]
def s(i):
    o = 8 + strstart + offs[i]; n = struct.unpack_from('<H', d, o)[0]; return d[o + 2:o + 2 + 2 * n].decode('utf-16-le', 'replace')
vc = next(i for i in range(cnt) if s(i) == 'versionCode')
for o in range(0, len(d) - 20, 4):
    ns, name, raw, size, r0, dt, val = struct.unpack_from('<IIIHBBI', d, o)
    if name == vc and size == 8 and dt == 0x10: struct.pack_into('<I', d, o + 16, code); break
open(p, 'wb').write(d)
PY
  mkdir -p "$B/m"; cp "$B/m.xml" "$B/m/AndroidManifest.xml"; zip -q -d "$B/un.apk" AndroidManifest.xml; (cd "$B/m" && zip -q ../un.apk AndroidManifest.xml)
fi
zipalign -f -p 4 "$B/un.apk" "$B/al.apk"
apksigner sign --ks mihir-tasks.keystore --ks-key-alias mihir --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out MIHIR-Tasks.apk "$B/al.apk"
rm -f MIHIR-Tasks.apk.idsig
apksigner verify MIHIR-Tasks.apk && aapt dump badging MIHIR-Tasks.apk | head -1
