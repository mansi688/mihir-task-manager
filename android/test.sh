#!/usr/bin/env bash
# JVM unit tests for the Android app's pure-Java parts (no emulator needed).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build/test && mkdir -p build/test
javac -d build/test src/com/mihir/taskmanager/BeaconParser.java test/com/mihir/taskmanager/*.java
java -cp build/test com.mihir.taskmanager.BeaconParserTest
