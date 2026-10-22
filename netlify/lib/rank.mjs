// Steal Scout ranking logic: parse the shopper's request, normalize listings,
// drop sponsored and over-budget items, score fit, and rank.
// Pure functions only, so it can be tested without calling any API.

const UNIT_ALIASES = [
  ["qt", ["qt", "qts", "quart", "quarts"]],
  ["in", ["in", "inch", "inches", '"', "”", "″", "''"]],
  ["ft", ["ft", "feet", "foot"]],
  ["gb", ["gb"]],
  ["tb", ["tb"]],
  ["lb", ["lb", "lbs", "pound", "pounds"]],
  ["oz", ["oz", "ounce", "ounces"]],
  ["w", ["w", "watt", "watts"]],
  ["mah", ["mah"]],
  ["l", ["l", "liter", "liters", "litre", "litres"]],
  ["cm", ["cm"]],
  ["mm", ["mm"]],
  ["hz", ["hz"]],
  ["gal", ["gal", "gallon", "gallons"]],
  ["cuft", ["cu ft", "cu. ft.", "cu.ft.", "cuft", "cubic feet", "cubic foot"]],
];
const UNIT_LOOKUP = new Map();
for (const [canon, list] of UNIT_ALIASES) for (const a of list) UNIT_LOOKUP.set(a, canon);
const UNIT_PATTERN = [...UNIT_LOOKUP.keys()]
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const STOPWORDS = new Set(
  "a an and the for with of to in on at by or is it its my me i we our that this be need want looking find best good great nice decent quality reliable cheap cheapest affordable under below less than max maximum min minimum at least most around about up no more over budget price dollars dollar size new used please some any one wide tall long deep high able can could that which easy easily should must also really very kind type style rated top".split(" ")
);
const QUALITY_RE = /\b(good|best|great|quality|reliable|decent|nice|top rated|highly rated|well reviewed|durable|sturdy)\b/i;
const GENERIC_HEADS = new Set("set sets kit kits pack packs combo bundle pair pairs system unit units".split(" "));
const BED_SIZES = ["twin xl", "twin", "full", "queen", "california king", "cal king", "king"];

const round2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function canonUnit(raw) {
  return UNIT_LOOKUP.get(raw.toLowerCase().replace(/\s+/g, " ").trim()) || null;
}

export function stem(w) {
  return w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
}

/** Parse "air fryer, at least 5 quarts, under $90" into a search plan. */
export function parseQuery(input) {
  let text = ` ${String(input || "").trim()} `;
  const plan = { raw: input, minPrice: null, maxPrice: null, constraints: [], condition: "any", size: null, bedSize: null };

  plan.wantsQuality = QUALITY_RE.test(text);

  // Price range: "$50-$90", "between 50 and 90 dollars"
  const range = text.match(/(?:between\s*)?\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:-|to|and)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)/i);
  if (range) {
    plan.minPrice = parseFloat(range[1].replace(/,/g, ""));
    plan.maxPrice = parseFloat(range[2].replace(/,/g, ""));
    text = text.replace(range[0], " ");
  }
  // Ceiling: "under $90", "below 90 dollars", "max $90", "up to $90", "$90 or less", "$90 max"
  const ceil =
    text.match(/(?:under|below|less than|no more than|up to|max(?:imum)?|budget(?: of)?|<)\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?/i) ||
    text.match(/(?:under|below|less than|no more than|up to|max(?:imum)?|budget(?: of)?)\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:dollars|bucks|usd)/i) ||
    text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:or less|max|tops|or under)/i);
  if (ceil && plan.maxPrice == null) {
    plan.maxPrice = parseFloat(ceil[1].replace(/,/g, "")) * (ceil[2] ? 1000 : 1);
    text = text.replace(ceil[0], " ");
  }

  // Clothing/shoe size: "size 10", "size 9.5", "size M"
  const size = text.match(/\b(?:size|sz)\s*(\d{1,2}(?:\.5)?|xxs|xs|s|m|l|xl|xxl|xxxl|small|medium|large)\b/i);
  if (size) {
    plan.size = size[1].toLowerCase();
    text = text.replace(size[0], " ");
  }
  // Bed size
  const bed = text.toLowerCase().match(new RegExp(`\\b(${BED_SIZES.map(esc).join("|")})\\b`));
  if (bed && /\b(mattress|bed|beds|sheets?|frame|comforter|duvet|headboard|topper|bedding|quilt|box spring)\b/i.test(text)) plan.bedSize = bed[1].replace("california", "cal");

  // Size/spec constraints: "at least 5 quarts", "under 10 lbs", "65 inch"
  const consRe = new RegExp(
    String.raw`(at least|minimum|min\.?|or more|over|more than|bigger than|at most|maximum|max\.?|under|less than|no more than|smaller than|lighter than)?\s*(\d+(?:\.\d+)?)\s*-?\s*(${UNIT_PATTERN})(?![a-z])(\s*(?:or more|or bigger|\+|or less|max))?`,
    "gi"
  );
  text = text.replace(consRe, (whole, pre, num, unitRaw, post) => {
    const unit = canonUnit(unitRaw);
    if (!unit) return whole;
    const value = parseFloat(num);
    const p = `${pre || ""} ${post || ""}`.toLowerCase();
    let kind = "approx";
    if (/at least|min|or more|over|more than|bigger|\+|or bigger/.test(p)) kind = "min";
    else if (/at most|max|under|less than|no more than|smaller|lighter|or less/.test(p)) kind = "max";
    plan.constraints.push({ unit, value, kind });
    return ` ${num} ${unit} `;
  });

  if (/\b(brand new|new only|only new|no used)\b/i.test(text)) plan.condition = "new";
  else if (/\b(used|pre-?owned|second ?hand|refurbished)\b/i.test(text)) plan.condition = "used-ok";
  text = text.replace(/\b(brand new|new only|only new|no used)\b/gi, " ");

  // Feature phrases are wishes about the item, not words to search for. Keep them as soft features.
  plan.features = [];
  const FEATURE_RE = /(?:,|\s)\s*(?:(?:that|which)\s+(?:is|are|can|will|has|have)?\s*|(?:is|are|be)\s+|(?:must|should)\s+(?:be\s+|have\s+)?|(?:able|easy)\s+to\s+(?:be\s+)?|can\s+(?:be\s+)?|with\s+(?:a\s+|an\s+)?)([a-z][a-z\s-]{2,40}?)(?=,|;|\.|$|\s+(?:and|under|below|less|max|for|that|which|with)\b)/gi;
  text = text.replace(FEATURE_RE, (whole, feat) => {
    plan.features.push(feat.trim().toLowerCase());
    return " ";
  });

  plan.searchText = text
    .replace(/\b(at least|at most|minimum|maximum|or more|or less|i need|i want|looking for|find me)\b/gi, " ")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const toWords = (s) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => !STOPWORDS.has(w) && !UNIT_LOOKUP.has(w))
      .filter((w) => (/^\d+$/.test(w) ? !plan.constraints.some((c) => String(c.value) === w) : w.length > 1));

  // "backpack for college": "for college" is the use, not the item. Keep it soft.
  const [itemPart, ...useParts] = plan.searchText.split(/\s+for\s+/i);
  plan.keywords = [...new Set(toWords(plan.searchText))];
  const itemWords = [...new Set(toWords(itemPart))];
  plan.softWords = [...new Set(toWords(useParts.join(" ")))].filter((w) => !itemWords.includes(w));

  // The head noun is the thing itself: "kitchen round table" -> table, "air fryer" -> fryer.
  // "washer and dryer set" -> the item is the washer/dryer, not "set"
  const nouns = itemWords.filter((w) => !/^\d+$/.test(w) && !BED_SIZES.includes(w));
  while (nouns.length > 1 && GENERIC_HEADS.has(nouns[nouns.length - 1])) nouns.pop();
  plan.head = nouns.length ? nouns[nouns.length - 1] : itemWords[itemWords.length - 1] || null;
  plan.modifiers = itemWords.filter((w) => w !== plan.head);
  plan.coreQuery = itemWords.join(" ");
  return plan;
}

/** All numbers in a title that carry the given unit, e.g. "6-Quart" -> [6] for "qt". */
export function numbersWithUnit(title, unit) {
  const aliases = UNIT_ALIASES.find(([c]) => c === unit)?.[1] || [];
  const alt = aliases.map(esc).join("|");
  const re = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*-?\s*(?:${alt})(?![a-z])`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(title))) out.push(parseFloat(m[1]));
  return out;
}

/** "+$44.44 delivery" -> {cost: 44.44}; "Free delivery" -> {cost: 0}; "+HKD 73.47" -> {foreign: true}. */
export function parseShipping(s) {
  if (!s) return { cost: null, foreign: false };
  const t = String(s);
  if (/\bfree\b/i.test(t) && !/\$\s?\d/.test(t.replace(/free[^,]*/i, ""))) return { cost: 0, foreign: false };
  if (/\b(HKD|GBP|EUR|CAD|AUD|CNY|RMB|JPY|INR|MXN|C\s?\$|AU\s?\$|A\s?\$|£|€|¥)/i.test(t)) return { cost: null, foreign: true };
  const m = t.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  return m ? { cost: parseFloat(m[1].replace(/,/g, "")), foreign: false } : { cost: null, foreign: false };
}

// Toys and miniatures match the words of almost any furniture or appliance search.
const TOY_RE = /\b(doll(?:house)?s?|barbie|miniatures?|mini figures?|diorama|figurines?|toys?|play ?sets?|pretend play|\d+\s*[:/]\s*\d+\s*scale|scale model|model kit|keychains?|ornaments?|magnets?|costumes?)\b/i;

// Listings that are explicitly not a working item
const BROKEN_RE = /\b(for parts|parts only|parts or repair|not working|non[- ]working|broken|as[- ]is|untested|box only|empty box|no console|read description|cracked|water damaged?|faulty|defective)\b/i;

const FURNITURE = new Set("table desk chair sofa couch bed dresser shelf shelve bookcase cabinet stool bench nightstand wardrobe ottoman mattress".split(" "));

// Ways a listing might say it has a feature the shopper asked for.
const FEATURE_SYNONYMS = {
  disassemble: ["detachable", "removable", "folding", "foldable", "collapsible", "knock down", "easy assembly", "disassemble"],
  fold: ["folding", "foldable", "collapsible", "fold"],
  wireless: ["wireless", "bluetooth", "cordless"],
  waterproof: ["waterproof", "water resistant", "ip67", "ip68"],
  quiet: ["quiet", "silent", "low noise"],
  adjustable: ["adjustable", "height adjustable", "extendable"],
  lumbar: ["lumbar", "back support", "ergonomic"],
};

const ACCESSORY_RE = /\b(liners?|case|cases|cover|covers|replacement|parts?|accessor(?:y|ies)|filters?|cables?|cords?|chargers?|adapters?|converters?|screen protectors?|protectors?|mounts?|skins?|stickers?|decals?|manuals?|refills?|pads?|lids?|knobs?|bags?|sleeves?|straps?|bands?|placemats?|place mats?|mats?|tablecloths?|table cloths?|runners?|toppers?|coasters?|centerpieces?|legs?|bases?|hardware|screws?|brackets?|casters?|glides?|wheels?|cylinders?|headrests?|armrests?|cushions?|slipcovers?|posters?|prints?|wall art|stencils?|templates?|patterns?|plans?|blueprints?|pans?|baskets?|racks?|trays?|silicone|remotes?|controllers?|docks?|stands?|calendars?|books?|guides?|pillows?|sheets?|encasements?|frames?|foundations?|portal|tips|batteries|battery)\b/i;

const USED_RE = /\b(used|pre-?owned|refurbished|renewed|open box|open-box|second ?hand)\b/i;

// Stores shoppers already know. Everything else that looks like a bare website gets a caution.
const KNOWN_STORES = /\b(walmart|target|best ?buy|amazon|home ?depot|lowe'?s|costco|sam'?s club|wayfair|kohl'?s|macy'?s|ebay|ikea|staples|office ?depot|newegg|b&h|adorama|apple|samsung|sony|lg|dell|lenovo|hp|microsoft|nike|adidas|under armour|reebok|new balance|asics|rei|dick'?s|academy|kroger|meijer|fred meyer|bed bath|overstock|ashley|nordstrom|jcpenney|zappos|dsw|foot locker|gamestop|bj'?s|qvc|hsn|chewy|petco|petsmart|ulta|sephora|cvs|walgreens|abt|ajmadison|appliances connection|the appliance barn|brandsmart|p\.?c\.? richard|conn'?s|mattress firm|sleep number|casper|nectar|purple|tempur|serta|sealy|zinus|anker|soundcore|bose|jbl|logitech|bagsmart|jansport|herschel|targus|belkin|ugreen|poshmark|mercari|swappa|back market|offerup)\b/i;

/** Turn SerpApi Google Shopping + eBay responses into one flat list. */
export function normalize(google, ebay) {
  const items = [];
  const removed = { sponsored: 0 };

  // Google: inline_shopping_results are the paid placements; shopping_results are the main grid.
  removed.sponsored += (google?.inline_shopping_results || []).length;
  for (const r of google?.shopping_results || []) {
    if (r.extracted_price == null) continue;
    const ext = (r.extensions || []).join(" ");
    items.push({
      origin: "google",
      title: r.title,
      price: r.extracted_price,
      oldPrice: r.extracted_old_price ?? null,
      source: r.source || "Store",
      link: r.product_link || r.link,
      thumbnail: r.thumbnail || null,
      rating: r.rating ?? null,
      reviews: r.reviews ?? null,
      delivery: r.delivery || null,
      condition: r.second_hand_condition || null,
      used: USED_RE.test(`${r.title} ${ext} ${r.second_hand_condition || ""}`),
      position: r.position ?? null,
    });
  }

  for (const r of ebay?.organic_results || []) {
    if (r.sponsored) { removed.sponsored++; continue; }
    const price = r.price?.extracted ?? r.price?.from?.extracted;
    if (price == null) continue;
    const shipping = typeof r.shipping === "string" ? r.shipping : r.shipping?.raw || null;
    items.push({
      origin: "ebay",
      title: r.title,
      price,
      priceRange: r.price?.to?.extracted != null && r.price.to.extracted !== price,
      oldPrice: null,
      source: "eBay",
      link: r.link,
      thumbnail: r.thumbnail || null,
      rating: r.rating ?? null,
      reviews: r.reviews ?? null,
      delivery: shipping,
      used: USED_RE.test(`${r.condition || ""} ${r.title}`),
      condition: r.condition || null,
      sellerFeedback: r.seller?.positive_feedback_in_percentage ?? null,
      sellerReviews: r.seller?.reviews ?? null,
      auction: /auction/i.test(r.buying_format || r.buying_format_text || ""),
      position: null,
    });
  }

  // Drop exact duplicates (same title, same store)
  const seen = new Set();
  const unique = items.filter((it) => {
    const k = `${it.source}|${it.title.toLowerCase().replace(/\W+/g, " ").trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { items: unique, removed };
}

/** Is this an accessory/part for the item rather than the item itself? */
function accessoryCheck(plan, title, tw) {
  if (!plan.head) return false;
  const headStem = stem(plan.head);
  const headAt = tw.findIndex((w) => stem(w) === headStem);
  const askedFor = (w) => plan.keywords.some((k) => stem(k) === stem(w));

  // "Grill Pan for Power XL Air Fryer", "Cylinder For ... office chair", "Portal Remote Player for PS5":
  // something before "for", and the item only named after it.
  const forAt = tw.indexOf("for");
  if (forAt > 0 && headAt > forAt) {
    const beforeFor = tw.slice(0, forAt);
    if (!beforeFor.some((w) => stem(w) === headStem)) return true;
  }

  if (headAt < 0) return false; // no item word at all; the missing-head penalty handles it
  const itemStems = new Set([headStem, ...(plan.modifiers || []).map(stem)]);
  const re = new RegExp(ACCESSORY_RE.source, "gi");
  for (const m of title.matchAll(re)) {
    const accWord = m[1].toLowerCase().split(" ").pop();
    if (askedFor(accWord)) continue;
    const accAt = tw.findIndex((w) => stem(w) === stem(accWord));
    if (accAt < 0) continue;
    const before = tw[accAt - 1] || "";
    const after = tw[accAt + 1] || "";

    // Compound names that are the item: "Sit Stand Desk", "Stand Up Desk", "Pillow Top Mattress", "Base Cabinet"
    if (/^(stand|stands)$/.test(accWord) && (before === "sit" || after === "up")) continue;
    if (accWord === "pillow" && after === "top") continue;
    if (itemStems.has(stem(after))) continue;

    // "Folding Table with Detachable Legs", "Air Fryer with Nonstick Pan": the accessory describes the item
    const between = tw.slice(Math.min(headAt, accAt) + 1, Math.max(headAt, accAt));
    if (accAt > headAt && between.some((w) => /^(with|w|includes|including|plus|and|comes|has)$/.test(w))) continue;
    if (/^(detachable|removable|adjustable|folding|foldable|metal|steel|wood|wooden|solid|sturdy|locking|iron|chrome|heavy|duty|non|slip|anti|built|lumbar|ergonomic|swivel|rolling|caster|padded)$/.test(before)) continue;

    // Accessory named before the item, just after it ("Table Cloth", "Chair: Back Foam Cushion"), or as the last word(s)
    if (accAt < headAt || accAt <= headAt + 3 || accAt >= tw.length - 2) return true;
  }
  return false;
}

/** How a listing's sizes compare with the size the shopper asked for. */
function sizeCheck(plan, title) {
  const t = title.toLowerCase();
  const notes = [];
  let score = 1;
  let fails = false;
  let multi = false;

  if (plan.bedSize) {
    const listed = BED_SIZES.filter((b) => new RegExp(`\\b${esc(b)}\\b`).test(t)).map((b) => b.replace("california", "cal"));
    const distinct = [...new Set(listed.map((b) => (b === "twin xl" ? "twin" : b)))];
    if (distinct.length >= 2) {
      multi = true;
      score = 0.75;
      notes.push(`Lists several sizes; the price shown may not be for ${plan.bedSize}`);
    } else if (distinct.length === 1 && !distinct.includes(plan.bedSize.replace("twin xl", "twin"))) {
      fails = true;
      score = 0;
      notes.push(`This is ${distinct[0]}, not ${plan.bedSize}`);
    }
  }

  if (plan.size) {
    const sz = esc(plan.size);
    const explicit = new RegExp(`\\b(?:size|sz|us|uk|men'?s|mens|women'?s|womens)\\s*:?\\s*${sz}(?![\\d.])|(?<![\\d.])${sz}\\s*(?:us|m|w|d)\\b`, "i");
    const rangeRe = /\b(?:size|sz|us)?\s*(\d{1,2}(?:\.5)?)\s*(?:~|-|–|to)\s*(\d{1,2}(?:\.5)?)\b/i;
    const otherSize = t.match(/\b(?:size|sz|us)\s*:?\s*(\d{1,2}(?:\.5)?|xxs|xs|s|m|l|xl|xxl)\b/i);
    const r = t.match(rangeRe);
    if (explicit.test(t)) score = 1;
    else if (r && /^\d/.test(plan.size) && +plan.size >= +r[1] && +plan.size <= +r[2]) {
      multi = true;
      score = 0.75;
      notes.push(`Lists sizes ${r[1]}–${r[2]}; check that ${plan.size} is in stock at this price`);
    } else if (otherSize && otherSize[1] !== plan.size) {
      fails = true;
      score = 0;
      notes.push(`This is size ${otherSize[1]}, not ${plan.size}`);
    } else {
      score = 0.6;
      notes.push(`Size not listed; check ${plan.size} is available`);
    }
  }
  return { score, fails, multi, notes };
}

/** Score and sort. Returns ranked results plus counts of what was filtered out. */
export function rank(plan, items) {
  const removed = { overBudget: 0, condition: 0, broken: 0 };
  const headStem = plan.head ? stem(plan.head) : null;
  const modStems = (plan.modifiers || []).map(stem);
  const softStems = (plan.softWords || []).map(stem);

  // Delivery-inclusive totals
  items = items.map((it) => {
    const ship = parseShipping(it.delivery);
    return { ...it, shipping: ship.cost, shippingForeign: ship.foreign, total: round2(it.price + (ship.cost || 0)) };
  });

  let pool = items.filter((it) => {
    if (plan.maxPrice != null && it.total > plan.maxPrice) { removed.overBudget++; return false; }
    if (plan.minPrice != null && it.price < plan.minPrice) { removed.overBudget++; return false; }
    if (plan.condition === "new" && it.used) { removed.condition++; return false; }
    return true;
  });

  pool = pool.map((it) => {
    const tw = it.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const titleStems = new Set(tw.map(stem));
    const notes = [];
    let fails = false;
    let flagged = false; // shown, but never the top pick

    // Keywords: the item word matters most, modifiers next, use-case words ("for college") only a little
    let kwPart;
    if (headStem) {
      const headHit = titleStems.has(headStem) ? 1 : 0;
      const modFrac = modStems.length ? modStems.filter((k) => titleStems.has(k)).length / modStems.length : 1;
      kwPart = 0.65 * headHit + 0.35 * modFrac;
    } else kwPart = 1;
    const softBonus = softStems.length ? (softStems.filter((k) => titleStems.has(k)).length / softStems.length) * 4 : 0;

    // Unit constraints ("at least 5 qt")
    let consScore = 1;
    if (plan.constraints.length) {
      const scores = plan.constraints.map((c) => {
        const nums = numbersWithUnit(it.title, c.unit);
        if (!nums.length) return 0.6; // can't tell from the title
        const ok = nums.some((n) =>
          c.kind === "min" ? n >= c.value : c.kind === "max" ? n <= c.value : Math.abs(n - c.value) / c.value <= 0.15
        );
        if (!ok) {
          fails = true;
          const want = c.kind === "min" ? `${c.value}+ ${c.unit}` : c.kind === "max" ? `${c.value} ${c.unit} or less` : `about ${c.value} ${c.unit}`;
          notes.push(`Wanted ${want}, this is ${nums[0]} ${c.unit}`);
        }
        return ok ? 1 : 0;
      });
      consScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    // Clothing, shoe and bed sizes
    const sz = sizeCheck(plan, it.title);
    if (plan.size || plan.bedSize) {
      consScore = plan.constraints.length ? (consScore + sz.score) / 2 : sz.score;
      if (sz.fails) fails = true;
      if (sz.multi) flagged = true;
      notes.push(...sz.notes);
    }

    const hasCons = plan.constraints.length || plan.size || plan.bedSize;
    let fit = hasCons ? 100 * (0.6 * kwPart + 0.4 * consScore) : 100 * (0.25 + 0.75 * kwPart);
    fit = Math.min(100, fit + softBonus);

    // Broken / for-parts listings
    if (BROKEN_RE.test(it.title) || /for parts|not working/i.test(it.condition || "")) {
      fit *= 0.2;
      flagged = true;
      notes.push("Listed as broken or for parts");
    }

    // Accessories and parts
    if (accessoryCheck(plan, it.title, tw)) {
      fit *= 0.45;
      flagged = true;
      notes.push("Looks like an accessory or part, not the item");
    }

    // Toys and miniatures
    const toyWord = (it.title.match(TOY_RE)?.[1] || "").toLowerCase();
    const askedToy = toyWord && plan.keywords.some((k) => stem(k) === stem(toyWord.split(" ").pop()));
    if (toyWord && !askedToy) {
      fit *= 0.25;
      flagged = true;
      notes.push("Looks like a toy or miniature, not the real thing");
    }
    // Furniture listed at a few inches is a miniature
    if (FURNITURE.has(headStem || "") && !toyWord) {
      const inches = numbersWithUnit(it.title, "in");
      if (inches.length && Math.max(...inches) < 10 && headStem !== "mattress") {
        fit *= 0.3;
        flagged = true;
        notes.push(`Only ${Math.max(...inches)} in, looks like a miniature`);
      }
    }

    // Soft features: small bonus when mentioned, no penalty when the title doesn't say
    if (plan.features?.length) {
      const t = it.title.toLowerCase();
      const hits = plan.features.filter((f) =>
        f.split(/\s+/).filter((w) => w.length > 3).some((w) => {
          const key = Object.keys(FEATURE_SYNONYMS).find((k) => w.startsWith(k.slice(0, 5)) || w.replace(/s+/, "s").startsWith(k.replace(/s+/, "s").slice(0, 5)));
          const alts = key ? FEATURE_SYNONYMS[key] : [w.slice(0, Math.max(4, w.length - 3))];
          return alts.some((a) => t.includes(a));
        })
      );
      if (hits.length) fit = Math.min(100, fit + 5);
    }

    // Trust. Product ratings count most. eBay seller feedback says the seller is honest, not that the product is good.
    let trust = 0.45;
    if (it.rating != null && Number(it.reviews) > 0) {
      const n = Number(it.reviews);
      trust = ((it.rating * n + 3.8 * 30) / (n + 30)) / 5;
    } else if (it.sellerFeedback != null) {
      trust = Math.max(0.3, Math.min(0.55, 0.3 + ((it.sellerFeedback - 95) / 5) * 0.25)) * (it.sellerReviews > 100 ? 1 : 0.9);
    }
    if (it.used) trust *= 0.92;
    if (it.auction) {
      trust *= 0.7;
      flagged = true;
      notes.push("Auction: the current bid, not the final price");
    }
    if (it.shippingForeign) {
      trust *= 0.75;
      notes.push("Ships from overseas; delivery cost and time unclear");
    }
    if (it.priceRange) {
      flagged = true;
      notes.push("Price shown is the cheapest option in the listing");
    }
    const src = String(it.source || "");
    const looksLikeSite = /\.(com|net|org|site|tech|shop|store|xyz|top|online|info|biz|co|us|io)\b/i.test(src);
    if (looksLikeSite && !KNOWN_STORES.test(src)) {
      trust *= 0.6;
      flagged = true;
      notes.push("Unfamiliar store; check it before buying");
    }

    return { ...it, fit: Math.round(fit), trust: round2(trust), fails, flagged, notes };
  });

  // A listing far cheaper than similar good matches is usually a part, a single variant, or too good to be true.
  const solid = pool.filter((it) => it.fit >= 70 && !it.fails && !it.flagged).map((it) => it.total).sort((a, b) => a - b);
  if (solid.length >= 4) {
    const median = solid[Math.floor(solid.length / 2)];
    pool.forEach((it) => {
      if (it.total < median * 0.35 && !it.notes.some((n) => /accessory|toy|broken|miniature/.test(n))) {
        it.fit = Math.round(it.fit * 0.6);
        it.flagged = true;
        it.notes.push("Priced far below similar items; check what's included");
      }
    });
  }

  // Price score uses delivered totals, relative to the good matches
  const decent = pool.filter((it) => it.fit >= 60 && !it.fails && !it.flagged).map((it) => it.total);
  const base = decent.length ? decent : pool.map((i) => i.total);
  const lo = Math.max(0.01, Math.min(...base));
  const [wf, wp, wt] = plan.wantsQuality ? [0.4, 0.2, 0.4] : [0.45, 0.25, 0.3];
  pool.forEach((it) => {
    // Cheapest decent option = 1; twice the price = about 0.6; five times = about 0.3
    const ps = Math.min(1, Math.pow(lo / Math.max(it.total, 0.01), 0.7));
    it.value = round2(wf * (it.fit / 100) + wp * ps + wt * it.trust);
  });

  pool.sort((a, b) => {
    const tier = (x) => (x.fails ? 3 : x.fit < 60 ? 2 : x.flagged ? 1 : 0);
    return tier(a) - tier(b) || b.value - a.value || a.total - b.total;
  });
  return { results: pool, removed };
}

/** The best result we'd stand behind as the top pick. */
export function topPick(results) {
  return results.find((x) => !x.fails && !x.flagged && x.fit >= 60) || null;
}

/** The price of the first thing a normal Google Shopping search shows (often an ad). */
export function firstNormalResult(google) {
  const ad = google?.inline_shopping_results?.[0];
  if (ad?.extracted_price != null) return { title: ad.title, price: ad.extracted_price, sponsored: true };
  const top = (google?.shopping_results || []).find((r) => r.extracted_price != null);
  return top ? { title: top.title, price: top.extracted_price, sponsored: false } : null;
}
