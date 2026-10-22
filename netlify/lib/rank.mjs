// Steal Scout ranking logic: parse the shopper's request, normalize listings,
// drop sponsored and over-budget items, score fit, and rank.
// Pure functions only, so it can be tested without calling any API.

const UNIT_ALIASES = [
  ["qt", ["qt", "qts", "quart", "quarts"]],
  ["in", ["in", "inch", "inches", '"', "”", "″"]],
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
  ["cuft", ["cu ft", "cu. ft.", "cu.ft.", "cubic feet", "cubic foot"]],
];
const UNIT_LOOKUP = new Map();
for (const [canon, list] of UNIT_ALIASES) for (const a of list) UNIT_LOOKUP.set(a, canon);
const UNIT_PATTERN = [...UNIT_LOOKUP.keys()]
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const STOPWORDS = new Set(
  "a an and the for with of to in on at by or is it its my me i we our that this be need want looking find best good cheap cheapest under below less than max maximum min minimum at least most around about up no more over budget price dollars dollar size new used please some any one wide tall long deep high able can could that which easy easily should must also really very kind type style".split(" ")
);

const round2 = (n) => Math.round(n * 100) / 100;

function canonUnit(raw) {
  return UNIT_LOOKUP.get(raw.toLowerCase().replace(/\s+/g, " ").trim()) || null;
}

/** Parse "air fryer, at least 5 quarts, under $90" into a search plan. */
export function parseQuery(input) {
  let text = ` ${String(input || "").trim()} `;
  const plan = { raw: input, minPrice: null, maxPrice: null, constraints: [], condition: "any" };

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

  plan.keywordsAll = null;
  plan.keywords = [
    ...new Set(
      plan.searchText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => !STOPWORDS.has(w) && !UNIT_LOOKUP.has(w))
        .filter((w) => (/^\d+$/.test(w) ? !plan.constraints.some((c) => String(c.value) === w) : w.length > 1))
    ),
  ];
  // The head noun is the thing itself: "kitchen round table" -> table, "air fryer" -> fryer.
  const words = plan.keywords.filter((w) => !/^\d+$/.test(w));
  plan.head = words.length ? words[words.length - 1] : null;
  plan.coreQuery = plan.keywords.join(" ");
  return plan;
}

/** All numbers in a title that carry the given unit, e.g. "6-Quart" -> [6] for "qt". */
export function numbersWithUnit(title, unit) {
  const aliases = UNIT_ALIASES.find(([c]) => c === unit)?.[1] || [];
  const alt = aliases.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*-?\s*(?:${alt})(?![a-z])`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(title))) out.push(parseFloat(m[1]));
  return out;
}

// Toys and miniatures match the words of almost any furniture or appliance search.
const TOY_RE = /\b(doll(?:house)?s?|barbie|miniatures?|mini figures?|diorama|figurines?|toys?|play ?sets?|pretend play|\d+\s*[:/]\s*\d+\s*scale|scale model|model kit|keychains?|ornaments?|magnets?|costumes?)\b/i;

const FURNITURE = new Set("table desk chair sofa couch bed dresser shelf shelve bookcase cabinet stool bench nightstand wardrobe ottoman".split(" "));

// Ways a listing might say it has a feature the shopper asked for.
const FEATURE_SYNONYMS = {
  disassemble: ["detachable", "removable", "folding", "foldable", "collapsible", "knock down", "easy assembly", "disassemble"],
  fold: ["folding", "foldable", "collapsible", "fold"],
  wireless: ["wireless", "bluetooth", "cordless"],
  waterproof: ["waterproof", "water resistant", "ip67", "ip68"],
  quiet: ["quiet", "silent", "low noise"],
  adjustable: ["adjustable", "height adjustable", "extendable"],
};

const ACCESSORY_RE = /\b(liners?|case|cases|cover|covers|replacement|parts?|accessor(?:y|ies)|filters?|cables?|chargers?|adapters?|screen protectors?|protectors?|mounts?|skins?|stickers?|decals?|manuals?|refills?|pads?|lids?|knobs?|bags?|sleeves?|straps?|bands?|placemats?|place mats?|mats?|tablecloths?|table cloths?|runners?|toppers?|coasters?|centerpieces?|legs?|hardware|screws?|brackets?|casters?|wheels?|cushions?|slipcovers?|protectors?|posters?|prints?|wall art|stencils?|templates?|patterns?|plans?|blueprints?)\b/i;

const USED_RE = /\b(used|pre-?owned|refurbished|renewed|open box|open-box|second ?hand)\b/i;

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

function stem(w) {
  return w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
}

/** Score and sort. Returns ranked results plus counts of what was filtered out. */
export function rank(plan, items) {
  const removed = { overBudget: 0, condition: 0 };
  const kwStems = plan.keywords.map(stem);

  let pool = items.filter((it) => {
    if (plan.maxPrice != null && it.price > plan.maxPrice) { removed.overBudget++; return false; }
    if (plan.minPrice != null && it.price < plan.minPrice) { removed.overBudget++; return false; }
    if (plan.condition === "new" && it.used) { removed.condition++; return false; }
    return true;
  });

  pool = pool.map((it) => {
    const titleWords = new Set(it.title.toLowerCase().split(/[^a-z0-9]+/).map(stem));
    const kwHit = kwStems.length ? kwStems.filter((k) => titleWords.has(k)).length / kwStems.length : 1;

    const notes = [];
    let consScore = 1;
    let fails = false;
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

    let fit = plan.constraints.length
      ? 100 * (0.55 * kwHit + 0.45 * consScore)
      : 100 * (0.3 + 0.7 * kwHit);

    // Accessories ("liners for air fryer", "case for iPhone") look like matches but aren't the item.
    // Only penalize when the shopper didn't ask for that accessory (someone searching "iphone case" wants cases).
    // An accessory word only means "accessory" when it comes before the item ("Placemats for Kitchen Table")
    // or right after it ("Table Cloth"). "Folding Table with Detachable Legs" is still a table.
    const accMatch = it.title.match(ACCESSORY_RE);
    const accWord = (accMatch?.[1] || "").toLowerCase();
    const askedFor = accWord && plan.keywords.some((k) => stem(k) === stem(accWord.split(" ").pop()));
    let accessory = !!accWord && !askedFor;
    if (accessory && plan.head) {
      const tw = it.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const headAt = tw.findIndex((w) => stem(w) === stem(plan.head));
      const accAt = tw.findIndex((w) => stem(w) === stem(accWord.split(" ").pop()));
      const before = tw[accAt - 1] || "";
      const describesItem = /^(detachable|removable|adjustable|folding|foldable|metal|steel|wood|wooden|solid|sturdy|with|and|locking|iron|chrome|heavy|duty|non|slip|anti|built|in)$/.test(before);
      const isTheProduct = accAt < headAt || accAt === headAt + 1 || accAt >= tw.length - 3;
      if (headAt > -1 && (describesItem || !isTheProduct)) accessory = false;
    }
    if (accessory) {
      fit *= 0.45;
      notes.push("Looks like an accessory, not the item");
    }
    const toyWord = (it.title.match(TOY_RE)?.[1] || "").toLowerCase();
    const askedToy = toyWord && plan.keywords.some((k) => stem(k) === stem(toyWord.split(" ").pop()));
    if (toyWord && !askedToy) {
      fit *= 0.25;
      notes.push("Looks like a toy or miniature, not the real thing");
    }
    // Furniture listed at a few inches is a miniature
    if (FURNITURE.has(stem(plan.head || "")) && !toyWord) {
      const inches = numbersWithUnit(it.title, "in");
      if (inches.length && Math.max(...inches) < 10) {
        fit *= 0.3;
        notes.push(`Only ${Math.max(...inches)} in, looks like a miniature`);
      }
    }
    // Must contain the head noun ("table") to be the item at all
    if (plan.head && !titleWords.has(stem(plan.head))) fit *= 0.7;

    // Soft features: small bonus when mentioned, no penalty when the title doesn't say
    if (plan.features?.length) {
      const t = it.title.toLowerCase();
      const hits = plan.features.filter((f) => {
        const words = f.split(/\s+/).filter((w) => w.length > 3);
        return words.some((w) => {
          const key = Object.keys(FEATURE_SYNONYMS).find((k) => w.startsWith(k.slice(0, 5)) || w.replace(/s+/, "s").startsWith(k.replace(/s+/, "s").slice(0, 5)));
          const alts = key ? FEATURE_SYNONYMS[key] : [w.slice(0, Math.max(4, w.length - 3))];
          return alts.some((a) => t.includes(a));
        });
      });
      if (hits.length) { fit = Math.min(100, fit + 5); it.featureHits = hits; }
    }

    // Trust: ratings pulled toward 4.0 when there are few reviews; eBay uses seller feedback
    let trust = 0.7;
    if (it.rating != null) {
      const n = Number(it.reviews) || 0;
      trust = ((it.rating * n + 4.0 * 20) / (n + 20)) / 5;
    } else if (it.sellerFeedback != null) {
      trust = Math.min(1, (it.sellerFeedback / 100) * (it.sellerReviews > 50 ? 1 : 0.9));
    }
    if (it.used) trust *= 0.92;

    return { ...it, fit: Math.round(fit), trust: round2(trust), fails, notes };
  });

  // A listing far cheaper than similar matches is usually an accessory, a part, or a misprice.
  const goodPrices = pool.filter((it) => it.fit >= 60 && !it.fails).map((it) => it.price).sort((a, b) => a - b);
  if (goodPrices.length >= 4) {
    const median = goodPrices[Math.floor(goodPrices.length / 2)];
    pool.forEach((it) => {
      if (it.price < median * 0.25 && !it.notes.length) {
        it.fit = Math.round(it.fit * 0.6);
        it.notes.push("Priced far below similar items; check what's included");
      }
    });
  }

  // Price score is relative to the decent-fit listings, so junk accessories don't set the floor
  const decent = pool.filter((it) => it.fit >= 60 && !it.fails).map((it) => it.price);
  const lo = decent.length ? Math.min(...decent) : Math.min(...pool.map((i) => i.price));
  const hi = decent.length ? Math.max(...decent) : Math.max(...pool.map((i) => i.price));
  pool.forEach((it) => {
    const ps = hi > lo ? Math.max(0, Math.min(1, (hi - it.price) / (hi - lo))) : 1;
    it.value = round2(0.5 * (it.fit / 100) + 0.3 * ps + 0.2 * it.trust);
  });

  pool.sort((a, b) => {
    const tier = (x) => (x.fails ? 2 : x.fit < 50 ? 1 : 0);
    return tier(a) - tier(b) || b.value - a.value || a.price - b.price;
  });
  return { results: pool, removed };
}

/** The price of the first thing a normal Google Shopping search shows (often an ad). */
export function firstNormalResult(google) {
  const ad = google?.inline_shopping_results?.[0];
  if (ad?.extracted_price != null) return { title: ad.title, price: ad.extracted_price, sponsored: true };
  const top = (google?.shopping_results || []).find((r) => r.extracted_price != null);
  return top ? { title: top.title, price: top.extracted_price, sponsored: false } : null;
}
