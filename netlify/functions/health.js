const VERSION = "1.0.0";

exports.handler = async (event) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify({
    ok: true,
    service: "the-pulpit",
    version: VERSION,
    timestamp: new Date().toISOString(),
  }),
});
