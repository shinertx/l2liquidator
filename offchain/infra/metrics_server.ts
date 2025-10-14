import http from 'http';
import { registry } from './metrics';

const srv = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    try {
      const data = await registry.metrics();
      res.writeHead(200, { 'Content-Type': registry.contentType });
      return res.end(data);
    } catch (e) {
      res.writeHead(500); return res.end((e as Error).message);
    }
  }
  if (req.url === '/live' || req.url === '/ready') {
    res.writeHead(200); return res.end('ok');
  }
  res.writeHead(404); res.end();
});

const isFabricProcess =
  process.env.IS_FABRIC === '1' || process.argv.some((arg) => arg.includes('arb_fabric'));
const portRaw = isFabricProcess
  ? process.env.FABRIC_PROM_PORT || process.env.PROM_PORT || '9470'
  : process.env.PROM_PORT || '9464';
const port = Number(portRaw);

srv.listen(Number.isFinite(port) ? port : isFabricProcess ? 9470 : 9464);
