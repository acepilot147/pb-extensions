const DOMAIN = "https://comix.to";
const API_BASE = "https://comix.to/api/v2"; 

// ⚠️ PASTE YOUR BYPASS DATA HERE ⚠️
const CF_COOKIE = "cf_clearance=";
const USER_AGENT = "";

const HEADERS = {
  "Referer": `${DOMAIN}/`,
  "User-Agent": USER_AGENT,
  "Cookie": CF_COOKIE,
  "Accept": "application/json"
};

async function fetchEndpoint(endpointName, url) {
  console.log(`\n=========================================`);
  console.log(`--- Fetching: ${endpointName} ---`);
  console.log(`URL: ${url}`);
  
  try {
    const response = await fetch(url, { method: "GET", headers: HEADERS });
    
    if (response.status === 403 || response.status === 503) {
      console.error(`❌ [403/503] Cloudflare Blocked!`);
      return null;
    }

    if (!response.ok) {
      console.error(`❌ HTTP Error: ${response.status} ${response.statusText}`);
      return null;
    }

    const json = await response.json();
    console.log(`✅ Success!`);
    return json;

  } catch (error) {
    console.error(`❌ Network or Parse Error:`, error.message);
    return null;
  }
}

// API Endpoint Functions
async function testGetMangaDetails(mangaId) {
  return await fetchEndpoint("Manga Details", `${API_BASE}/manga/${mangaId}?includes[]=author&includes[]=artist`);
}
async function testGetChapters(mangaId, page = 1) {
  return await fetchEndpoint("Chapters List", `${API_BASE}/manga/${mangaId}/chapters?page=${page}&limit=100&order[number]=desc`);
}
async function testGetChapterPages(chapterId) {
  return await fetchEndpoint("Chapter Pages", `${API_BASE}/chapters/${chapterId}`);
}
async function testHomePageSection(type, limit = 5) {
  return await fetchEndpoint(`Home Page (${type})`, `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=${limit}&scope=hot&includes[]=author`);
}

// Execution Block
(async () => {
  console.log("Starting Automated API Health Check...\n");

  // --- STEP 1: Fetch Latest Manga ---
  const latestData = await testHomePageSection("latest", 5);

  if (!latestData?.result?.items?.length) {
    console.error("Failed to fetch latest manga.");
    return;
  }

  const mangaList = latestData.result.items;
  
  console.log(`\n📚 Found ${mangaList.length} manga. Here is the RAW JSON for the very first manga:\n`);
  // This prints the entire JSON object of the first manga so you can find the ID field
  console.log(JSON.stringify(mangaList[0], null, 2));

  const TEST_MANGA_ID = mangaList[0].hash_id; 
  
  console.log(`\n🔍 Auto-selecting Manga ID/Slug: ${TEST_MANGA_ID}`);
  
  if (!TEST_MANGA_ID) {
      console.log("⚠️ Could not determine the Manga ID field. Please look at the JSON above and update the script.");
      return;
  }

  // --- STEP 2: Manga Details ---
  const detailsData = await testGetMangaDetails(TEST_MANGA_ID);
  if (detailsData?.result) {
      console.log(`\n📖 RAW JSON for Manga Details:\n`);
      console.log(JSON.stringify(detailsData.result, null, 2));
  }

  // --- STEP 3: Test Chapters ---
  const chaptersData = await testGetChapters(TEST_MANGA_ID);
  
  if (!chaptersData?.result?.items?.length) {
    console.log(`\n⚠️ No chapters found. Cannot test chapter pages.`);
    return;
  }

  const chapterList = chaptersData.result.items;
  console.log(`\n📑 RAW JSON for the first Chapter:\n`);
  console.log(JSON.stringify(chapterList[0], null, 2));

  const TEST_CHAPTER_ID = chapterList[0].hash_id;

  // --- STEP 4: Chapter Pages ---
  const pagesData = await testGetChapterPages(TEST_CHAPTER_ID);
  if (pagesData?.result) {
      console.log(`\n📄 RAW JSON for Chapter Pages:\n`);
      // We slice the pages array so it doesn't print 50 image URLs and flood your console
      const pagesPreview = {
          ...pagesData.result,
          pages: pagesData.result.pages ? pagesData.result.pages.slice(0, 3) : [] 
      };
      console.log(JSON.stringify(pagesPreview, null, 2));
      console.log(`... and ${pagesData.result.pages?.length - 3 || 0} more pages.`);
  }

  console.log("\n✅ All sequential API tests completed!");
})();