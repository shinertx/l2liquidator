.PHONY: verify-monitoring monitoring-up monitoring-down

MON_DIR := $(CURDIR)/monitoring

verify-monitoring:
	@echo "Checking Prometheus config..."
	docker run --rm -v $(MON_DIR):/work --entrypoint promtool prom/prometheus:v2.52.0 \
		check config /work/prometheus.yml
	docker run --rm -v $(MON_DIR):/work --entrypoint promtool prom/prometheus:v2.52.0 \
		check rules /work/prometheus_rules.yml
	docker run --rm -v $(MON_DIR):/work --entrypoint amtool prom/alertmanager:v0.27.0 \
		check-config /work/alertmanager.yml
	@echo "Monitoring config looks good ✅"

monitoring-up:
	docker compose up -d postgres-exporter prometheus alertmanager loki promtail grafana

monitoring-down:
	docker compose down grafana promtail loki alertmanager prometheus postgres-exporter
