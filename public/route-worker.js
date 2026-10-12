import { routeConnections } from './router.js';

self.onmessage = event => {
  const { generation, connections, boxes } = event.data;
  const routes = routeConnections(connections, boxes);
  self.postMessage({ generation, routes: [...routes] });
};
