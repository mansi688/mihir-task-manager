package com.mihir.taskmanager;
public class BeaconParserTest {
    public static void main(String[] a) {
        // f7826da6-4fa2-4e98-8024-bc5b71e0893e, major 1, minor 300, tx -59
        int[] raw = {0x02,0x15, 0xf7,0x82,0x6d,0xa6, 0x4f,0xa2, 0x4e,0x98, 0x80,0x24, 0xbc,0x5b,0x71,0xe0,0x89,0x3e, 0x00,0x01, 0x01,0x2c, 0xc5};
        byte[] d = new byte[raw.length]; for (int i = 0; i < raw.length; i++) d[i] = (byte) raw[i];
        String id = BeaconParser.iBeaconId(d);
        if (!"f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:300".equals(id)) throw new AssertionError("got " + id);
        d[1] = 0x16; if (BeaconParser.iBeaconId(d) != null) throw new AssertionError("non-iBeacon accepted");
        if (BeaconParser.iBeaconId(new byte[5]) != null) throw new AssertionError("short frame accepted");
        System.out.println("BeaconParser OK: " + id);
    }
}
