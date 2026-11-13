import { randomUUID, X509Certificate } from "node:crypto";

export function iphoneCertificateProfile(certificate: Buffer): string {
  if (!new X509Certificate(certificate).ca)
    throw new Error("The phone certificate must be a root CA.");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.varshan.phone-certificate</string>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Varshan Wi-Fi Certificate</string>
<key>PayloadDescription</key><string>Installs the public certificate for your local Varshan server. Enable full trust in Certificate Trust Settings after installation.</string>
<key>PayloadOrganization</key><string>Varshan</string>
<key>PayloadRemovalDisallowed</key><false/>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.varshan.phone-certificate.root</string>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Varshan Local Network CA</string>
<key>PayloadCertificateFileName</key><string>varshan-local-ca.cer</string>
<key>PayloadContent</key><data>${certificate.toString("base64")}</data>
</dict></array></dict></plist>`;
}
