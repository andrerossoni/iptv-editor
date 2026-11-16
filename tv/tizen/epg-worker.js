/**
 * Baixa e le um guia XMLTV fora da linha principal (a tela da TV segue leve).
 * Recebe { id, src, list } e devolve { id, by } ou { id, error }.
 */
importScripts('epg-parse.js');

self.onmessage = async (e) => {
  const { id, src, list } = e.data;
  try {
    self.postMessage({ id, by: await readXmltv(src, list) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
