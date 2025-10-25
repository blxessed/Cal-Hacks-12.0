if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const axios = require('axios');

const websiteScrape = async (url) => {
  try {
    let scrapeResults;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
      },
      timeout: 15000
    });
    const html = response.data; 

    scrapeResults = scrapeResults

    console.log("Scraped:", url );
    return JSON.stringify({ results: scrapeResults });

  } catch (error) {
    console.error("General error:", error.response?.data || error.message);
    return JSON.stringify({ error: "General error, try again later" });
  }
};