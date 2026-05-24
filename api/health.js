export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'fitness-telegram-bot',
    time: new Date().toISOString()
  });
}

