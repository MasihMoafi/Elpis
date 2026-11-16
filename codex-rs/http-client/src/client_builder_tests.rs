use super::*;
use http::HeaderValue;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[tokio::test]
async fn ipv4_only_respects_the_selected_address_family() {
    for (host, enabled, rejected) in [
        ("127.0.0.1", true, false),
        ("::1", true, true),
        ("::1", false, false),
    ] {
        let listener = std::net::TcpListener::bind((host, 0)).expect("listener should bind");
        let address = listener.local_addr().expect("listener address");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = [0_u8; 4096];
                        stream.read(&mut request).expect("HTTP request");
                        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").expect("HTTP response");
                        return true;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return false;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept failed: {error}"),
                }
            }
        });
        let output = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "client_builder::tests::ipv4_only_http_probe",
                "--nocapture",
            ])
            .env("ELPIS_IPV4_ONLY", if enabled { "1" } else { "0" })
            .env("ELPIS_TEST_HTTP_URL", format!("http://{address}/"))
            .env("ELPIS_TEST_HTTP_REJECTED", if rejected { "1" } else { "0" })
            .output()
            .expect("HTTP probe should run");
        assert!(
            output.status.success(),
            "{host}, enabled={enabled}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            server.join().expect("HTTP fixture should finish"),
            !rejected
        );
    }
}

#[tokio::test]
async fn ipv4_only_http_probe() {
    let Ok(url) = std::env::var("ELPIS_TEST_HTTP_URL") else {
        return;
    };
    let result = HttpClientBuilder::new()
        .connect_timeout(Duration::from_secs(2))
        .build_direct()
        .expect("HTTP client")
        .get(url)
        .send()
        .await;
    let rejected = std::env::var("ELPIS_TEST_HTTP_REJECTED").as_deref() == Ok("1");
    if rejected {
        assert!(
            result.is_err(),
            "IPv4-only client must not connect over IPv6"
        );
    } else {
        assert!(result.expect("HTTP connection").status().is_success());
    }
}

#[tokio::test]
async fn custom_ca_fallback_preserves_builder_configuration() {
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).expect("HTTP listener should bind");
    let address = listener
        .local_addr()
        .expect("HTTP listener should have an address");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("HTTP listener should accept");
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let bytes_read = stream.read(&mut chunk).expect("HTTP request should read");
            assert!(bytes_read > 0, "HTTP request should include headers");
            request.extend_from_slice(&chunk[..bytes_read]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .expect("HTTP listener should write response");
        String::from_utf8(request).expect("HTTP request should be UTF-8")
    });
    let mut headers = HeaderMap::new();
    headers.insert("x-builder-test", HeaderValue::from_static("preserved"));
    let client = HttpClientBuilder::new()
        .default_headers(headers)
        .build_with_custom_ca_fallback_using(ProxyRouting::Direct, |_| {
            Err(BuildCustomCaTransportError::InvalidCaFile {
                source_env: "TEST_CA_ENV",
                path: PathBuf::from("invalid-test-ca.pem"),
                detail: "synthetic invalid CA".to_string(),
            })
        });

    let client = HttpClient {
        backend: HttpClientBackend::Direct(client),
    };

    let response = client
        .get(format!("http://{address}/fallback"))
        .send()
        .await
        .expect("fallback client should send request");
    assert!(response.status().is_success());
    let request = server.join().expect("HTTP listener should finish");
    assert!(
        request
            .lines()
            .any(|line| line.eq_ignore_ascii_case("x-builder-test: preserved"))
    );
}
