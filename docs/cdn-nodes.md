# CDN nodes

A CDN node publishes one WebSocket, gRPC, or XHTTP inbound from an existing
Xray node through a generic CDN or reverse proxy. It has no SSH host and does
not run a second Xray instance.

## Requirements

- The origin must be an active Xray node.
- The selected inbound must use WebSocket, gRPC, or XHTTP with TLS or no
  transport security. REALITY cannot work behind a TLS-terminating CDN.
- Configure at least one public CDN domain or edge address.
- TLS publication requires an SNI hostname. When a domain is present, it is
  used as the default SNI and Host.

Keep the origin out of user groups if it must not appear directly in
subscriptions. Assign the CDN node to those groups instead.

## Address modes

- Domain only: one subscription entry connects to the CDN domain.
- Pinned edges: every enabled address is emitted as a separate entry. The
  domain remains optional and can still supply SNI/Host and DNS discovery.

The Resolve edges button reads the domain's current A and AAAA records. The
result is copied into the editable edge list; it is not refreshed
automatically.

## XHTTP through a CDN

Which client paths an XHTTP origin accepts depends on where its session and
sequence markers live:

- Default placement (`path`): the client appends the markers to its own path and
  the inbound reads them back as the segments that follow its prefix. The CDN
  client path must therefore be empty or identical to the origin path — a longer
  one, such as `/api/events.php` over an origin `/api`, makes the inbound treat
  `events.php` as the session ID of every client at once.
- Any other placement (query, header, cookie): the path carries nothing, the
  inbound only checks its prefix, and the CDN may publish a longer path that
  looks like an ordinary web resource.

A WebSocket origin matches its path exactly, so the CDN client path must either
be left empty or be identical to the origin one.

Advanced XHTTP framing fields are available on both main and extra Xray
inbounds, including upload method and placement, chunk sizing, padding
obfuscation, and session/sequence placement. They are published to clients in
every encoding a client can read: flat `snake_case` query keys in the VLESS URI
for the sing-box family, an `extra` JSON object in the same URI for the Xray
family, and native transport keys in the sing-box and Xray JSON profiles.

Mihomo's `xhttp-opts` carries path, mode and host only, so an inbound that
negotiates framing cannot be expressed in a Clash profile. Such an inbound is
omitted from the Clash subscription rather than emitted as a proxy that looks
healthy and fails on every request. It stays available in all other formats.

## Changing the origin

An Xray node that CDN fronts point at cannot be deleted, and cannot have its
type, inbound transport or transport security changed while they exist. The
panel, the REST API and the MCP tool all refuse the edit and name the node that
blocks it — otherwise the fronts would keep publishing entries built from an
inbound that no longer exists in that shape.

CDN nodes are not supported for Hysteria 2 because Hysteria uses QUIC/UDP,
while this node type targets HTTP-capable CDN transports.
