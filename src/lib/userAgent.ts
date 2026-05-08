export function parseUserAgent(ua: string): { browser: string; os: string } {
  if (!ua || ua === '-') return { browser: 'Unknown', os: 'Unknown' }

  let decoded = ua
  try {
    decoded = decodeURIComponent(ua)
  } catch {
    // keep original
  }

  let os = 'Unknown'
  if (/CrOS/i.test(decoded)) os = 'ChromeOS'
  else if (/Android/i.test(decoded)) os = 'Android'
  else if (/iPhone|iPad|iPod/i.test(decoded)) os = 'iOS'
  else if (/Windows NT/i.test(decoded)) os = 'Windows'
  else if (/Mac OS X/i.test(decoded)) os = 'macOS'
  else if (/Linux/i.test(decoded)) os = 'Linux'

  let browser = 'Unknown'
  if (/Googlebot/i.test(decoded)) browser = 'Googlebot'
  else if (/bingbot/i.test(decoded)) browser = 'Bingbot'
  else if (/YandexBot/i.test(decoded)) browser = 'YandexBot'
  else if (/Baiduspider/i.test(decoded)) browser = 'Baiduspider'
  else if (/AhrefsBot/i.test(decoded)) browser = 'AhrefsBot'
  else if (/SemrushBot/i.test(decoded)) browser = 'SemrushBot'
  else if (/bot|spider|crawler/i.test(decoded)) browser = 'Other Bot'
  else if (/Edg\//i.test(decoded)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(decoded)) browser = 'Opera'
  else if (/SamsungBrowser/i.test(decoded)) browser = 'Samsung Browser'
  else if (/Chrome/i.test(decoded) && !/Chromium/i.test(decoded)) browser = 'Chrome'
  else if (/Firefox/i.test(decoded)) browser = 'Firefox'
  else if (/Safari/i.test(decoded) && !/Chrome/i.test(decoded)) browser = 'Safari'
  else if (/MSIE|Trident/i.test(decoded)) browser = 'IE'
  else if (/Chromium/i.test(decoded)) browser = 'Chromium'

  return { browser, os }
}
