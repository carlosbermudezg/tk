const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const fetchOpts = {
    headers: { 
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
    }
};

fetch("https://www.tiktok.com/foryou", fetchOpts)
  .then(async resp => {
    console.log("Status:", resp.status);
    console.log("Headers:");
    for (const [key, value] of resp.headers.entries()) {
      console.log(`  ${key}: ${value}`);
    }
    const cookies = resp.headers.getSetCookie();
    console.log("Set-Cookie headers:", cookies);
    
    const body = await resp.text();
    console.log("First 500 chars of body:");
    console.log(body.substring(0, 500));
  })
  .catch(err => {
    console.error("Error:", err);
  });
