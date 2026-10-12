package com.mihir.taskmanager;

/** Pure-Java iBeacon parsing (no Android classes), so it can be unit-tested on any JVM. */
final class BeaconParser {
    private BeaconParser() { }
    /** Apple manufacturer data (company 0x004C, already stripped) → "uuid:major:minor" in lower case, or null. */
    static String iBeaconId(byte[] d) {
        if (d == null || d.length < 23 || d[0] != 0x02 || d[1] != 0x15) return null;
        StringBuilder u = new StringBuilder();
        for (int i = 2; i < 18; i++) {
            u.append(String.format("%02x", d[i] & 0xff));
            if (i == 5 || i == 7 || i == 9 || i == 11) u.append('-');
        }
        int major = ((d[18] & 0xff) << 8) | (d[19] & 0xff);
        int minor = ((d[20] & 0xff) << 8) | (d[21] & 0xff);
        return u + ":" + major + ":" + minor;
    }
}
