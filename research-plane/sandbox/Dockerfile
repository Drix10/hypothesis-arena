# Research-worker sandbox image (doc 08 sec. 8.2 container spec).
#
# DEPLOYMENT BOX (Linux build host with a running daemon):
#  1. Replace the tag below with the immutable digest
#     (docker inspect --format='{{.RepoDigests}}') and record it in the
#     build record alongside the SBOM + vuln scan. An unpinned image is
#     a build failure (D3).
#  2. Run with: --user 65532:65532 --read-only --cap-drop=ALL
#     --pids-limit 64 --memory=2g --cpus=1.0 --network=none, plus the
#     egress-proxy sidecar for allowlisted destinations only.
#  3. Never mount: the docker socket, any writable host path, the
#     journal, HALT, STAGE, or any credential file. The features output
#     directory is mounted write-only via the supervisor, never by the
#     agent user.
#  4. Prove: unauthorized-destination probe fails at the proxy
#     (counted), and the research identity cannot read/write the
#     mirotrade/mirojev homes (setup-identities.sh + isolation test).
FROM python:3.11-slim
RUN useradd -u 65532 -m worker && \
    pip install --no-cache-dir requests beautifulsoup4 lxml pydantic pandas feedparser && \
    rm -rf /root/.cache
USER 65532
WORKDIR /work
# No ENTRYPOINT: the supervisor invokes explicit module commands only.
CMD ["python", "-c", "print('worker image ready')"]
