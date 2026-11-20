import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseQuickConnectTarget,
  sanitizeWindowsFilename,
  parseFtpsCertError,
} from "../src/utils/pathAndUrl.ts";

describe("parseQuickConnectTarget", () => {
  it("parses protocol, user, port and strips remote path from sftp URL", () => {
    const parsed = parseQuickConnectTarget(
      "sftp://alice@example.com:2222/var/www/html",
      "22",
      "FTP",
      ""
    );
    assert.deepEqual(parsed, {
      protocol: "SFTP",
      host: "example.com",
      port: "2222",
      username: "alice",
    });
  });

  it("preserves explicit username over URL username", () => {
    const parsed = parseQuickConnectTarget("ftp://alice@files.lan/", "", "SFTP", "bob");
    assert.deepEqual(parsed, {
      protocol: "FTP",
      host: "files.lan",
      port: "21",
      username: "bob",
    });
  });

  it("supports IPv6 literals with and without ports or zone IDs", () => {
    assert.deepEqual(parseQuickConnectTarget("ftps://[2001:db8::1]:990", "22", "SFTP", ""), {
      protocol: "FTPS",
      host: "2001:db8::1",
      port: "990",
      username: "",
    });
    assert.deepEqual(parseQuickConnectTarget("[fe80::1%eth0]:2222", "", "SFTP", "root"), {
      protocol: "SFTP",
      host: "fe80::1%eth0",
      port: "2222",
      username: "root",
    });
    assert.deepEqual(parseQuickConnectTarget("::1", "", "SFTP", ""), {
      protocol: "SFTP",
      host: "::1",
      port: "22",
      username: "",
    });
    assert.deepEqual(parseQuickConnectTarget("[::1]", "", "FTPS", ""), {
      protocol: "FTPS",
      host: "::1",
      port: "21",
      username: "",
    });
  });
});

describe("sanitizeWindowsFilename", () => {
  it("replaces forbidden characters and trailing dots/spaces", () => {
    assert.equal(sanitizeWindowsFilename("report:v2?.txt ."), "report_v2_.txt");
    assert.equal(sanitizeWindowsFilename(".."), "unnamed_file");
    assert.equal(sanitizeWindowsFilename("   "), "unnamed_file");
  });

  it("prefixes DOS reserved device names and caps length at 240 chars", () => {
    assert.equal(sanitizeWindowsFilename("CON.txt"), "_CON.txt");
    assert.equal(sanitizeWindowsFilename("nul"), "_nul");
    const longName = "a".repeat(260);
    assert.equal(Array.from(sanitizeWindowsFilename(longName)).length, 240);
  });
});

describe("parseFtpsCertError", () => {
  it("parses TOFU unknown and changed certificate errors", () => {
    assert.deepEqual(parseFtpsCertError("FTPS_CERT_UNKNOWN|SHA256:abcd|self signed cert"), {
      kind: "unknown",
      fingerprint: "SHA256:abcd",
      detail: "self signed cert",
    });
    assert.deepEqual(parseFtpsCertError("FTPS_CERT_CHANGED|SHA256:new|SHA256:old|mismatch"), {
      kind: "changed",
      fingerprint: "SHA256:new",
      expected: "SHA256:old",
      detail: "mismatch",
    });
    assert.equal(parseFtpsCertError("530 Login incorrect"), null);
  });
});
