# Wellness and legal disclaimer

WHOOP Personal MCP is an independent, open-source personal wellness tool. It
retrieves read-only data from a WHOOP account and computes summaries that an AI
client may use in a conversation.

## Not medical advice

The software, its computed metrics, and any AI response that uses them are for
general informational and wellness purposes only. They are not medical advice,
a diagnosis, treatment, a medical device, or a substitute for a qualified
health professional. Metrics such as the experimental Day Strain ratio,
recovery trends, sleep debt, and target-event context are simplified estimates.
They have not been clinically validated for your circumstances and can be
incomplete, stale, or wrong.

Do not use this project to make emergency, medication, diagnosis, return-to-play,
or other high-stakes health decisions. If you may be experiencing an emergency,
contact local emergency services. Ask an appropriate clinician about symptoms,
injury, pregnancy, a medical condition, or a material change to training.

AI systems can misread accurate data, invent facts, or give unsafe advice.
Review the underlying dates and values, keep a human in control, and stop an
activity if it feels unsafe.

## Personal, single-user scope

One deployment is designed for one person and one linked WHOOP account. The
same owner may connect more than one trusted MCP client. Do not use one instance
for multiple people, a team, patients, research participants, employees, or
customers. It has no tenant isolation, role-based access control, clinical
audit trail, or regulated records workflow.

## WHOOP API terms and owner consent

Using the software does not grant rights to use the WHOOP APIs or data outside
WHOOP's current terms. Each operator must review and comply with the
[WHOOP API Terms of Use](https://developer.whoop.com/api-terms-of-use/), create
their own personal Developer app, keep its credentials confidential, and obtain
the owner's express authorization before accessing data. Before sending a tool
result to an MCP client or AI provider, the owner must also explicitly opt in to
that disclosure and understand the destination/provider.

The current server requests limited read scopes, uses HTTPS for remote
deployments, and does not persist WHOOP API responses or tool results. Those
design choices do not ensure that every operator, host, client, model provider,
or downstream use complies with the WHOOP terms. The terms contain additional
requirements and restrictions, including for credentials, security incidents,
third-party disclosure, permanent copies/caching, branding, and termination.
They can change. Operators must disconnect/revoke access and delete applicable
local and downstream copies when their use terminates.

## HIPAA and other health privacy laws

This project is not represented as HIPAA compliant and is not offered for use
by HIPAA covered entities or business associates. The maintainers do not offer
a Business Associate Agreement. Do not use it to create, receive, maintain, or
transmit protected health information for a covered entity or business
associate.

WHOOP's current API Terms state that, unless WHOOP agrees otherwise in writing,
WHOOP does not represent that its APIs satisfy HIPAA obligations. They also say
a covered entity or business associate must not use the APIs in a way that
transmits PHI without WHOOP's prior written consent. That contractual condition
does not make this project HIPAA compliant, does not replace the operator's own
legal/security analysis, and does not authorize covered-entity use of this
project.

Whether HIPAA applies is contextual: it depends on who is using the software,
the relationships between the parties, the data, and the purpose. Fitness or
health-related data is not automatically covered by HIPAA, and being outside
HIPAA does not mean no law applies. Depending on the operator and use, the FTC
Act, the FTC Health Breach Notification Rule, state consumer-health privacy
laws, data-breach laws, contracts, and other requirements may apply. See the
[FTC's health privacy guidance](https://www.ftc.gov/business-guidance/resources/collecting-using-or-sharing-consumer-health-information-look-hipaa-ftc-act-health-breach).

This file is general information, not legal advice. It cannot determine your
obligations or eliminate liability. Consult qualified legal and security
professionals before any organizational, commercial, research, employment, or
regulated use.

## No warranty; limitation of liability

The project is provided under the MIT License, including its no-warranty and
limitation-of-liability terms. To the fullest extent permitted by applicable
law, use is at your own risk. Some jurisdictions do not allow every warranty
disclaimer or liability limitation, so the license and this notice may not
exclude all responsibility in every situation.

Support for an MCP protocol revision is a technical interoperability claim, not
a certification by the MCP project, Anthropic, xAI, OpenAI, another client
vendor, WHOOP, or a regulator. Client vendors can change protocol, OAuth,
retention, and product behavior independently. Test the exact client version and
deployment you intend to use; compatibility does not establish security,
fitness for a particular purpose, legal compliance, or medical correctness.

## Independence and trademarks

This project is not affiliated with, endorsed by, or sponsored by WHOOP, xAI,
Anthropic, OpenAI, OpenClaw, Railway, or any other client or hosting provider.
Names and trademarks belong to their respective owners.

Read [PRIVACY.md](PRIVACY.md) before connecting an AI client and
[SECURITY.md](SECURITY.md) before exposing the server to the internet.
