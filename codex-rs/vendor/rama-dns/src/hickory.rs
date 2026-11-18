//! Modified in Elpis to use Hickory 0.26.3.
//! dns using the [`hickory_resolver`] crate

use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
};

pub use hickory_resolver as resolver;
use hickory_resolver::{
    TokioResolver,
    config::{CLOUDFLARE, GOOGLE, QUAD9, ResolverConfig},
    net::runtime::TokioRuntimeProvider,
    proto::rr::{
        Name, RData,
        rdata::{A, AAAA},
    },
};

use rama_core::error::{ErrorContext, OpaqueError};
use rama_core::telemetry::tracing;
use rama_net::address::Domain;
use rama_utils::macros::generate_set_and_with;

use crate::DnsResolver;

#[derive(Debug, Clone)]
/// [`DnsResolver`] using the [`hickory_resolver`] crate
pub struct HickoryDns(Result<Arc<TokioResolver>, Arc<str>>);

impl Default for HickoryDns {
    #[cfg(any(target_family = "unix", target_os = "windows"))]
    fn default() -> Self {
        Self::try_new_system().unwrap_or_else(|err| {
            tracing::warn!(
                "fail to create system HickoryDns client: fallback to cloudflare: {err}"
            );
            Self::new_cloudflare()
        })
    }

    #[cfg(not(any(target_family = "unix", target_os = "windows")))]
    fn default() -> Self {
        Self::new_cloudflare()
    }
}

impl HickoryDns {
    #[inline]
    /// Construct a [`HickoryDnsBuilder`] used to build
    /// a custom [`HickoryDns`] instead of the default [`HickoryDns::new`].
    #[must_use]
    pub fn builder() -> HickoryDnsBuilder {
        HickoryDnsBuilder::default()
    }

    #[inline]
    /// Construct a new [`HickoryDns`] instance with the [`Default`] setup.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    /// Construct a new non-shared [`HickoryDns`] instance using Google's nameservers.
    ///
    /// Creates a default configuration, using `8.8.8.8`, `8.8.4.4` and `2001:4860:4860::8888`,
    /// `2001:4860:4860::8844` (thank you, Google).
    ///
    /// Please see Google's [privacy
    /// statement](https://developers.google.com/speed/public-dns/privacy) for important information
    /// about what they track, many ISP's track similar information in DNS.
    ///
    /// To use the system configuration see: [`Self::new_system`].
    pub fn new_google() -> Self {
        tracing::trace!("create HickoryDns resolver using default google config");
        Self::builder()
            .with_config(ResolverConfig::udp_and_tcp(&GOOGLE))
            .build()
    }

    #[inline]
    /// Construct a new non-shared [`HickoryDns`] instance using Cloudflare's nameservers.
    ///
    /// Creates a default configuration, using `1.1.1.1`, `1.0.0.1` and `2606:4700:4700::1111`, `2606:4700:4700::1001` (thank you, Cloudflare).
    ///
    /// Please see: <https://www.cloudflare.com/dns/>
    ///
    /// To use the system configuration see: [`Self::new_system`].
    pub fn new_cloudflare() -> Self {
        tracing::trace!("create HickoryDns resolver using default cloudflare config");
        Self::builder()
            .with_config(ResolverConfig::udp_and_tcp(&CLOUDFLARE))
            .build()
    }

    #[inline]
    /// Construct a new non-shared [`HickoryDns`] instance using Quad9's nameservers.
    ///
    /// Creates a configuration, using `9.9.9.9`, `149.112.112.112` and `2620:fe::fe`, `2620:fe::fe:9`,
    /// the "secure" variants of the quad9 settings (thank you, Quad9).
    ///
    /// Please see: <https://www.quad9.net/faq/>
    ///
    /// To use the system configuration see: [`Self::new_system`].
    pub fn new_quad9() -> Self {
        tracing::trace!("create HickoryDns resolver using default quad9 config");
        Self::builder()
            .with_config(ResolverConfig::udp_and_tcp(&QUAD9))
            .build()
    }

    #[cfg(any(target_family = "unix", target_os = "windows"))]
    /// Construct a new [`HickoryDns`] with the system configuration.
    ///
    /// This will use `/etc/resolv.conf` on Unix OSes and the registry on Windows.
    pub fn try_new_system() -> Result<Self, OpaqueError> {
        tracing::trace!("try to create HickoryDns resolver using system config");
        Ok(TokioResolver::builder_tokio()
            .context("build async dns resolver with system conf")
            .inspect_err(|err| {
                tracing::debug!("failed to create HickoryDns resolver using system config: {err:?}")
            })?
            .build()
            .context("build async dns resolver with system conf")?
            .into())
    }
}

impl From<TokioResolver> for HickoryDns {
    fn from(value: TokioResolver) -> Self {
        Self(Ok(Arc::new(value)))
    }
}

#[derive(Debug, Clone, Default)]
/// A [`Builder`] to [`build`][`Self::build`] a [`HickoryDns`] instance.
pub struct HickoryDnsBuilder {
    config: Option<self::resolver::config::ResolverConfig>,
    options: Option<self::resolver::config::ResolverOpts>,
}

impl HickoryDnsBuilder {
    generate_set_and_with! {
        /// Define the [`ResolverConfig`][`config::ResolverConfig`] used.
        pub fn config(mut self, config: Option<self::resolver::config::ResolverConfig>) -> Self {
            self.config = config;
            self
        }
    }

    generate_set_and_with! {
        /// Define the [`ResolverOpts`][`config::ResolverOpts`] used.
        #[must_use]
        pub fn options(mut self, options: Option<self::resolver::config::ResolverOpts>) -> Self {
            self.options = options;
            self
        }
    }

    /// Build a [`HickoryDns`] instance, consuming [`self`].
    ///
    /// [`Clone`] the [`HickoryDnsBuilder`] prior to calling this method in case you
    /// still need the builder afterwards.
    pub fn build(self) -> HickoryDns {
        let mut resolver_builder = TokioResolver::builder_with_config(
            self.config
                .unwrap_or_else(|| ResolverConfig::udp_and_tcp(&CLOUDFLARE)),
            TokioRuntimeProvider::default(),
        );
        if let Some(options) = self.options {
            *resolver_builder.options_mut() = options;
        }
        HickoryDns(
            resolver_builder
                .build()
                .map(Arc::new)
                .map_err(|err| Arc::from(err.to_string())),
        )
    }
}

impl DnsResolver for HickoryDns {
    type Error = OpaqueError;

    async fn txt_lookup(&self, domain: Domain) -> Result<Vec<Vec<u8>>, Self::Error> {
        let name = fqdn_from_domain(domain)?;

        let mut results = vec![];
        let resolver = self
            .0
            .as_ref()
            .map_err(|err| OpaqueError::from_display(err.to_string()))?;
        for record in resolver
            .txt_lookup(name)
            .await
            .context("lookup TXT entry")?
            .answers()
        {
            let RData::TXT(txt) = &record.data else {
                continue;
            };
            for value in txt.txt_data.iter() {
                results.push(value.to_vec());
            }
        }
        Ok(results)
    }

    async fn ipv4_lookup(&self, domain: Domain) -> Result<Vec<Ipv4Addr>, Self::Error> {
        let name = fqdn_from_domain(domain)?;
        let resolver = self
            .0
            .as_ref()
            .map_err(|err| OpaqueError::from_display(err.to_string()))?;
        Ok(resolver
            .ipv4_lookup(name)
            .await
            .context("lookup IPv4 address(es)")?
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::A(A(ip)) => Some(*ip),
                _ => None,
            })
            .collect())
    }

    async fn ipv6_lookup(&self, domain: Domain) -> Result<Vec<Ipv6Addr>, Self::Error> {
        let name = fqdn_from_domain(domain)?;
        let resolver = self
            .0
            .as_ref()
            .map_err(|err| OpaqueError::from_display(err.to_string()))?;
        Ok(resolver
            .ipv6_lookup(name)
            .await
            .context("lookup IPv6 address(es)")?
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::AAAA(AAAA(ip)) => Some(*ip),
                _ => None,
            })
            .collect())
    }
}

fn fqdn_from_domain(domain: Domain) -> Result<Name, OpaqueError> {
    let mut name = Name::from_utf8(domain).context("try to consume a Domain as a Dns Name")?;
    name.set_fqdn(true);
    Ok(name)
}

#[cfg(test)]
mod backport_tests {
    use super::*;
    use hickory_resolver::config::{ConnectionConfig, NameServerConfig};
    use std::net::{IpAddr, Ipv4Addr};
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
