
let submittedPubMedId = "";
let retrievedArticle = null;

const form = document.getElementById("pubmed-form");
const input = document.getElementById("pubmed-id");
const status = document.getElementById("status");
const button = form.querySelector('button[type="submit"]');
const results = document.getElementById("results");

// Maximum number of similar articles to retrieve.
const MAX_SIMILAR_ARTICLES = 5;

// Fetch and parse article metadata.
function parseArticle(article) {
    const getText = selector =>
    article.querySelector(selector)?.textContent.trim() || "";

    // Extract abstract sections.
    const abstract = Array.from(
    article.querySelectorAll("Abstract > AbstractText")
    ).map(section => {
    const label = section.getAttribute("Label");
    const text = section.textContent.trim();

    return label ? `${label}: ${text}` : text;
    }).join("\n\n");

    // Extract author names.
    const authors = Array.from(
    article.querySelectorAll("AuthorList > Author")
    ).map(author => {
    const collectiveName =
        author.querySelector("CollectiveName")?.textContent.trim();

    if (collectiveName) {
        return collectiveName;
    }

    const first =
        author.querySelector("ForeName")?.textContent.trim() || "";

    const last =
        author.querySelector("LastName")?.textContent.trim() || "";

    return `${first} ${last}`.trim();
    }).filter(Boolean);

    // Extract MeSH descriptors, major topic flags,
    // and associated qualifiers.
    const meshTerms = Array.from(
    article.querySelectorAll(
        "MeshHeadingList > MeshHeading"
    )
    ).map(heading => {
    const descriptor =
        heading.querySelector("DescriptorName");

    const term = descriptor?.textContent.trim() || "";

    const majorTopic =
        descriptor?.getAttribute("MajorTopicYN") === "Y";

    const qualifiers = Array.from(
        heading.querySelectorAll("QualifierName")
    ).map(qualifier => ({
        term: qualifier.textContent.trim(),
        majorTopic:
        qualifier.getAttribute("MajorTopicYN") === "Y"
    })).filter(qualifier => qualifier.term);

    return {
        term,
        majorTopic,
        qualifiers
    };
    }).filter(item => item.term);

    // Extract author-supplied keywords.
    const keywords = Array.from(
    article.querySelectorAll("KeywordList > Keyword")
    ).map(keyword => keyword.textContent.trim()).filter(Boolean);

    return {
    pmid: getText("MedlineCitation > PMID"),
    title: getText("ArticleTitle"),
    journal: getText("Journal > Title"),
    authors,
    abstract,
    doi: getText('ArticleId[IdType="doi"]'),
    pmcid: getText('ArticleId[IdType="pmc"]'),
    meshTerms,
    keywords
    };
}

// Fetch the original article by PMID.
async function fetchPubMedArticle(pmid) {
    const url = new URL(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    );

    url.search = new URLSearchParams({
    db: "pubmed",
    id: pmid,
    retmode: "xml"
    }).toString();

    const response = await fetch(url);

    if (!response.ok) {
    throw new Error(
        `Article request failed (${response.status}).`
    );
    }

    const xml = new DOMParser().parseFromString(
    await response.text(),
    "application/xml"
    );

    if (xml.querySelector("parsererror")) {
    throw new Error("Could not parse the PubMed response.");
    }

    const article = xml.querySelector("PubmedArticle");

    if (!article) {
    throw new Error(
        "No journal article found for this PubMed ID."
    );
    }

    return parseArticle(article);
}

// Retrieve similar article PMIDs using ELink.
async function fetchSimilarArticlePmids(pmid) {
    const url = new URL(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi"
    );

    url.search = new URLSearchParams({
    dbfrom: "pubmed",
    db: "pubmed",
    id: pmid,
    cmd: "neighbor",
    linkname: "pubmed_pubmed",
    retmode: "xml"
    }).toString();

    const response = await fetch(url);

    if (!response.ok) {
    throw new Error(
        `Similar articles request failed (${response.status}).`
    );
    }

    const xmlText = await response.text();

    const xml = new DOMParser().parseFromString(
    xmlText,
    "application/xml"
    );

    if (xml.querySelector("parsererror")) {
    throw new Error(
        "Could not parse the similar articles response."
    );
    }

    const linkSet = Array.from(
    xml.querySelectorAll("LinkSetDb")
    ).find(set =>
    set.querySelector("LinkName")?.textContent.trim() ===
    "pubmed_pubmed"
    );

    if (!linkSet) {
    console.warn(
        "No similar article link set found:",
        xmlText
    );
    return [];
    }

    // Preserve NCBI's returned order and exclude duplicates
    // and the original article.
    const seen = new Set([pmid]);
    const pmids = [];

    for (const id of linkSet.querySelectorAll(":scope > Link > Id")) {
    const similarPmid = id.textContent.trim();

    if (/^\d+$/.test(similarPmid) && !seen.has(similarPmid)) {
        seen.add(similarPmid);
        pmids.push(similarPmid);
    }

    if (pmids.length >= MAX_SIMILAR_ARTICLES) {
        break;
    }
    }

    return pmids;
}

// Fetch metadata for all selected similar articles in one request.
async function fetchSimilarArticles(pmid) {
    const similarPmids = await fetchSimilarArticlePmids(pmid);

    if (similarPmids.length === 0) {
    return [];
    }

    const url = new URL(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    );

    url.search = new URLSearchParams({
    db: "pubmed",
    id: similarPmids.join(","),
    retmode: "xml"
    }).toString();

    const response = await fetch(url);

    if (!response.ok) {
    throw new Error(
        `Similar article metadata request failed (${response.status}).`
    );
    }

    const xml = new DOMParser().parseFromString(
    await response.text(),
    "application/xml"
    );

    if (xml.querySelector("parsererror")) {
    throw new Error(
        "Could not parse similar article metadata."
    );
    }

    const articles = Array.from(
    xml.querySelectorAll("PubmedArticle")
    ).map(parseArticle);

    // EFetch may return records in a different order.
    // Restore the order returned by ELink.
    const rank = new Map(
    similarPmids.map((id, index) => [id, index])
    );

    articles.sort(
    (a, b) =>
        (rank.get(a.pmid) ?? Infinity) -
        (rank.get(b.pmid) ?? Infinity)
    );

    return articles.slice(0, MAX_SIMILAR_ARTICLES);
}

// Safely create HTML elements containing text.
function createElement(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;

    if (className) {
    element.className = className;
    }

    return element;
}

function addTextSection(parent, heading, text) {
    const section = document.createElement("section");
    section.className = "result-section";

    section.appendChild(createElement("h3", heading));
    section.appendChild(createElement("p", text));

    parent.appendChild(section);
}

function addListSection(
    parent,
    heading,
    items,
    formatter,
    emptyText
) {
    const section = document.createElement("section");
    section.className = "result-section";

    section.appendChild(createElement("h3", heading));

    if (!items.length) {
    section.appendChild(createElement("p", emptyText));
    } else {
    const list = document.createElement("ul");

    items.forEach(item => {
        list.appendChild(
        createElement("li", formatter(item))
        );
    });

    section.appendChild(list);
    }

    parent.appendChild(section);
}

// Format each MeSH descriptor and qualifier separately.
// Lowercase all terms and preserve major topic asterisks.
function formatMeshTerms(meshTerms) {
    return meshTerms.flatMap(item => {
    const descriptor =
        item.term.toLowerCase() +
        (item.majorTopic ? "*" : "");

    if (item.qualifiers.length === 0) {
        return [descriptor];
    }

    return item.qualifiers.map(qualifier => {
        const qualifierText =
        qualifier.term.toLowerCase() +
        (qualifier.majorTopic ? "*" : "");

        return `${descriptor} / ${qualifierText}`;
    });
    });
}

// Display the original article with full metadata.
function displayOriginalArticle(article, parent) {
    const container = document.createElement("article");

    container.appendChild(
    createElement("h2", article.title || "Untitled article")
    );

    const metadata = document.createElement("div");
    metadata.className = "metadata";

    [
    `PubMed ID: ${article.pmid}`,
    `Authors: ${article.authors.join(", ") || "Not available"}`,
    `Journal: ${article.journal || "Not available"}`,
    // `DOI: ${article.doi || "Not available"}`,
    // `PMCID: ${article.pmcid || "Not available"}`
    ].forEach(item => {
    metadata.appendChild(createElement("p", item));
    });

    container.appendChild(metadata);

    addTextSection(
    container,
    "Abstract",
    article.abstract || "No abstract available."
    );

    addListSection(
    container,
    "MeSH Terms",
    formatMeshTerms(article.meshTerms),
    term => term,
    "No MeSH terms available."
    );

    addListSection(
    container,
    "Keywords",
    article.keywords.map(keyword => keyword.toLowerCase()),
    keyword => keyword,
    "No keywords available."
    );

    parent.appendChild(container);
}

// Display similar articles with title, PMID, and terms only.
// No article numbering, authors, journal, or abstract.
function displaySimilarArticle(article, parent) {
    const container = document.createElement("article");
    container.className = "similar-article";

    container.appendChild(
    createElement("h3", article.title || "Untitled article")
    );

    container.appendChild(
    createElement("p", `PMID: ${article.pmid}`)
    );

    addListSection(
    container,
    "MeSH Terms",
    formatMeshTerms(article.meshTerms),
    term => term,
    "No MeSH terms available."
    );

    addListSection(
    container,
    "Keywords",
    article.keywords.map(keyword => keyword.toLowerCase()),
    keyword => keyword,
    "No keywords available."
    );

    parent.appendChild(container);
}

// Handle form submission.
form.addEventListener("submit", async function(event) {
    event.preventDefault();

    results.replaceChildren();

    const pmid = input.value.trim();

    if (!/^[0-9]+$/.test(pmid)) {
    status.textContent =
        "Please enter a valid numeric PubMed ID.";

    input.setAttribute("aria-invalid", "true");
    return;
    }

    submittedPubMedId = pmid;
    retrievedArticle = null;

    input.removeAttribute("aria-invalid");
    button.disabled = true;
    status.textContent = "Loading article...";

    try {
    // Retrieve and display the original article.
    retrievedArticle = await fetchPubMedArticle(
        submittedPubMedId
    );

    displayOriginalArticle(retrievedArticle, results);

    status.textContent =
        "Original article retrieved. Finding similar articles...";

    // Retrieve up to five similar articles and their metadata.
    const similarArticles = await fetchSimilarArticles(
        retrievedArticle.pmid
    );

    results.appendChild(
        createElement("h2", "Similar Articles")
    );

    if (similarArticles.length === 0) {
        results.appendChild(
        createElement("p", "No similar articles found.")
        );
    } else {
        similarArticles.forEach(article => {
        displaySimilarArticle(article, results);
        });
    }

    status.textContent =
        `Complete. Retrieved the original article and ${similarArticles.length} similar article(s).`;

    console.log("Original article:", retrievedArticle);
    console.log("Similar articles:", similarArticles);

    } catch (error) {
    status.textContent = error.message;
    console.error("PubMed API error:", error);

    } finally {
    button.disabled = false;
    }
});
