// Time entry shared by the day view and the workout builder. Accepts "m:ss" or
// microwave-style digits suited to phone number pads: "130" -> 1:30, "45" -> 0:45.
// Mirrors parse_duration in app.py.
window.FitTime = {
  // Seconds, null for blank, or NaN if it can't be read.
  parse(text) {
    const t = String(text).trim();
    if (!t) return null;
    if (t.includes(":")) {
      const m = /^(\d*):(\d{1,2})$/.exec(t);
      return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN;
    }
    if (!/^\d+$/.test(t)) return NaN;
    const padded = t.padStart(3, "0");
    return Number(padded.slice(0, -2)) * 60 + Number(padded.slice(-2));
  },
  format(sec) {
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  },
};
