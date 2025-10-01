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

srv.listen(process.env.PROM_PORT || 9464);
