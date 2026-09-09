function errorText(message) {
  try { const body=JSON.parse(message);if(typeof body?.error?.message==='string') return body.error.message; } catch {}
  return message;
}
module.exports={errorText};
