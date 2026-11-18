#[cfg(test)]
mod backport_tests {
    use rama_dns::hickory::resolver::config::{ConnectionConfig, NameServerConfig, ResolverConfig};
    use rama_dns::{DnsResolver, HickoryDns};
    use rama_net::address::Domain;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use tokio::net::UdpSocket;

    // An actual local DNS server tests the adapter's wire responses, not a mocked resolver.
    #[tokio::test]
    async fn resolves_address_and_txt_records_and_reports_missing_names() {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut bytes = [0u8; 2048];
            loop {
                let (len, peer) = socket.recv_from(&mut bytes).await.unwrap();
                let query = &bytes[..len];
                assert_eq!(
                    &query[10..12],
                    &[0, 0],
                    "default lookup must not enable EDNS"
                );
                let mut end = 12;
                while query[end] != 0 {
                    end += 1 + query[end] as usize;
                }
                end += 5; // terminating byte and QTYPE/QCLASS
                let qtype = u16::from_be_bytes([query[end - 4], query[end - 3]]);
                let missing = query[13..].starts_with(b"missing");
                let mut reply = query[..end].to_vec();
                reply[2] = 0x81;
                reply[3] = if missing { 0x83 } else { 0x80 };
                reply[6] = 0;
                reply[7] = u8::from(!missing);
                reply[8] = 0;
                reply[9] = 0;
                reply[10] = 0;
                reply[11] = 0;
                if !missing {
                    let data: &[u8] = match qtype {
                        1 => &[192, 0, 2, 5],
                        28 => &[0x20, 1, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
                        16 => &[3, b'o', b'n', b'e', 3, b't', b'w', b'o'],
                        _ => panic!("unexpected type {qtype}"),
                    };
                    reply.extend_from_slice(&[0xc0, 0x0c]);
                    reply.extend_from_slice(&qtype.to_be_bytes());
                    reply.extend_from_slice(&[0, 1, 0, 0, 0, 30]);
                    reply.extend_from_slice(&(data.len() as u16).to_be_bytes());
                    reply.extend_from_slice(data);
                }
                socket.send_to(&reply, peer).await.unwrap();
            }
        });
        let mut connection = ConnectionConfig::udp();
        connection.port = port;
        let nameserver =
            NameServerConfig::new(IpAddr::V4(Ipv4Addr::LOCALHOST), true, vec![connection]);
        let config = ResolverConfig::from_parts(None, vec![], vec![nameserver]);
        let resolver = HickoryDns::builder().with_config(config).build();
        let domain = Domain::from_static("answer.test");
        assert_eq!(
            resolver.ipv4_lookup(domain.clone()).await.unwrap(),
            vec![Ipv4Addr::new(192, 0, 2, 5)]
        );
        assert_eq!(
            resolver.ipv6_lookup(domain.clone()).await.unwrap(),
            vec!["2001:db8::5".parse::<Ipv6Addr>().unwrap()]
        );
        assert_eq!(
            resolver.txt_lookup(domain).await.unwrap(),
            vec![b"one".to_vec(), b"two".to_vec()]
        );
        assert!(
            resolver
                .ipv4_lookup(Domain::from_static("missing.test"))
                .await
                .is_err()
        );
        server.abort();
    }
}
