const form = document.getElementById("pubmed-form");
const input = document.getElementById("pubmed-id");
const scopeSelect = document.getElementById("article-scope");
const statusMessage = document.getElementById("status");
const button = form.querySelector('button[type="submit"]');
const results = document.getElementById("results");

// Allowed values for the "Results" drop down
// (number of similar articles to include).
const VALID_SCOPES = ["0", "5", "10"];

// Colors used in the charts.
const MESH_COLOR = "#2a6ebb";
const KEYWORD_COLOR = "#e07b39";

// ---------- Fetching and parsing ----------

// Publication year of an article (or null if none can be found).
// Order: journal issue date -> MedlineDate (e.g. "2019 Jan-Feb")
// -> electronic article date -> date added to PubMed.
function parsePublicationYear(article) {
    const text = selector =>
        article.querySelector(selector)?.textContent.trim() || "";

    const candidates = [
        text("Journal > JournalIssue > PubDate > Year"),
        text("Journal > JournalIssue > PubDate > MedlineDate"),
        text("Article > ArticleDate > Year"),
        text('PubMedPubDate[PubStatus="pubmed"] > Year')
    ];

    for (const value of candidates) {
        const match = value.match(/\b\d{4}\b/);

        if (match) {
            return Number(match[0]);
        }
    }

    return null;
}

// Parse article metadata from a <PubmedArticle> XML node.
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

    // Extract MeSH descriptors, major topic flags,
    // and associated qualifiers.
    const meshTerms = Array.from(
        article.querySelectorAll("MeshHeadingList > MeshHeading")
    ).map(heading => {
        const descriptor = heading.querySelector("DescriptorName");

        const term = descriptor?.textContent.trim() || "";
        const majorTopic = descriptor?.getAttribute("MajorTopicYN") === "Y";

        const qualifiers = Array.from(
            heading.querySelectorAll("QualifierName")
        ).map(qualifier => ({
            term: qualifier.textContent.trim(),
            majorTopic: qualifier.getAttribute("MajorTopicYN") === "Y"
        })).filter(qualifier => qualifier.term);

        return { term, majorTopic, qualifiers };
    }).filter(item => item.term);

    // Extract author-supplied keywords.
    const keywords = Array.from(
        article.querySelectorAll("KeywordList > Keyword")
    ).map(keyword => keyword.textContent.trim()).filter(Boolean);

    return {
        pmid: getText("MedlineCitation > PMID"),
        title: getText("ArticleTitle"),
        year: parsePublicationYear(article),
        abstract,
        meshTerms,
        keywords
    };
}

// Parse an XML response or throw a readable error.
function parseXml(text, errorMessage) {
    const xml = new DOMParser().parseFromString(text, "application/xml");

    if (xml.querySelector("parsererror")) {
        throw new Error(errorMessage);
    }

    return xml;
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
        throw new Error(`Article request failed (${response.status}).`);
    }

    const xml = parseXml(
        await response.text(),
        "Could not parse the PubMed response."
    );

    const article = xml.querySelector("PubmedArticle");

    if (!article) {
        throw new Error("No journal article found for this PubMed ID.");
    }

    return parseArticle(article);
}

// Retrieve similar article PMIDs using ELink (up to `limit`).
async function fetchSimilarArticlePmids(pmid, limit) {
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

    const xml = parseXml(
        xmlText,
        "Could not parse the similar articles response."
    );

    const linkSet = Array.from(xml.querySelectorAll("LinkSetDb")).find(
        set => set.querySelector("LinkName")?.textContent.trim() ===
            "pubmed_pubmed"
    );

    if (!linkSet) {
        console.warn("No similar article link set found:", xmlText);
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

        if (pmids.length >= limit) {
            break;
        }
    }

    return pmids;
}

// Fetch metadata for the similar articles in one request.
async function fetchSimilarArticles(pmid, limit) {
    const similarPmids = await fetchSimilarArticlePmids(pmid, limit);

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

    const xml = parseXml(
        await response.text(),
        "Could not parse similar article metadata."
    );

    const articles = Array.from(
        xml.querySelectorAll("PubmedArticle")
    ).map(parseArticle);

    // EFetch may return records in a different order.
    // Restore the order returned by ELink.
    const rank = new Map(similarPmids.map((id, index) => [id, index]));

    articles.sort(
        (a, b) =>
            (rank.get(a.pmid) ?? Infinity) - (rank.get(b.pmid) ?? Infinity)
    );

    return articles.slice(0, limit);
}

// ---------- Term helpers ----------

// Lowercased MeSH descriptor names (qualifiers excluded).
const getMeshDescriptors = article =>
    article.meshTerms.map(item => item.term.toLowerCase());

const getKeywords = article =>
    article.keywords.map(keyword => keyword.toLowerCase());

// Display text for one MeSH heading:
// "descriptor* / qualifier1, qualifier2*" (* = major topic).
function formatMeshHeading(item) {
    const descriptor = item.term.toLowerCase() + (item.majorTopic ? "*" : "");

    if (item.qualifiers.length === 0) {
        return descriptor;
    }

    const qualifiers = item.qualifiers.map(
        qualifier =>
            qualifier.term.toLowerCase() + (qualifier.majorTopic ? "*" : "")
    );

    return `${descriptor} / ${qualifiers.join(", ")}`;
}

// Count how many articles contain each term
// (an article counts once per term).
function countTerms(articles, getTerms) {
    const counts = new Map();

    articles.forEach(article => {
        new Set(getTerms(article)).forEach(term => {
            counts.set(term, (counts.get(term) || 0) + 1);
        });
    });

    return counts;
}

// Top N terms by count; ties are broken alphabetically.
function topTerms(counts, n = 5) {
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, n);
}

// ---------- DOM helpers ----------

function createElement(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;

    if (className) {
        element.className = className;
    }

    return element;
}

// Escape text before placing it in Highcharts' HTML tooltip.
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function createChartContainer(parent) {
    const container = document.createElement("div");
    container.className = "chart";
    parent.appendChild(container);
    return container;
}

// Title + abstract of the submitted article.
function displayTitleAndAbstract(article, parent) {
    parent.appendChild(
        createElement("h2", article.title || "Untitled article")
    );

    parent.appendChild(createElement("h3", "Abstract"));
    parent.appendChild(
        createElement(
            "p",
            article.abstract || "No abstract available.",
            "abstract"
        )
    );
}

// Two-column table: MeSH terms | Keywords.
function displayTermsTable(article, parent) {
    const mesh = article.meshTerms.map(formatMeshHeading);
    const keywords = getKeywords(article);
    const rowCount = Math.max(mesh.length, keywords.length);

    if (rowCount === 0) {
        parent.appendChild(
            createElement("p", "No MeSH terms or keywords available.")
        );
        return;
    }

    const table = document.createElement("table");
    table.className = "data-table";

    table.appendChild(createElement("caption", "MeSH Terms and Keywords"));

    const headRow = document.createElement("tr");
    [`MeSH Terms (${mesh.length})`, `Keywords (${keywords.length})`]
        .forEach(label => {
            const th = createElement("th", label);
            th.scope = "col";
            headRow.appendChild(th);
        });

    const thead = document.createElement("thead");
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    for (let i = 0; i < rowCount; i++) {
        const row = document.createElement("tr");
        row.appendChild(createElement("td", mesh[i] || ""));
        row.appendChild(createElement("td", keywords[i] || ""));
        tbody.appendChild(row);
    }

    table.appendChild(tbody);
    parent.appendChild(table);
}

// Two-column table: PubMed ID (linked) | Title.
function displaySimilarArticlesTable(articles, parent) {
    const table = document.createElement("table");
    table.className = "data-table";

    table.appendChild(createElement("caption", "Similar Articles"));

    const headRow = document.createElement("tr");
    ["PubMed ID", "Title"].forEach(label => {
        const th = createElement("th", label);
        th.scope = "col";
        headRow.appendChild(th);
    });

    const thead = document.createElement("thead");
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    articles.forEach(article => {
        const row = document.createElement("tr");

        const idCell = document.createElement("td");
        idCell.className = "pmid";

        const link = createElement("a", article.pmid);
        link.href = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        idCell.appendChild(link);

        row.appendChild(idCell);
        row.appendChild(createElement("td", article.title || "Untitled article"));
        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    parent.appendChild(table);
}

// ---------- Charts ----------

function renderChart(container, options) {
    Highcharts.chart(container, Highcharts.merge({
        credits: { enabled: false },
        legend: { enabled: false },
        yAxis: { min: 0, allowDecimals: false }
    }, options));
}

// Column chart: total MeSH terms vs. total keywords for one article.
function renderTotalsChart(article, parent) {
    renderChart(createChartContainer(parent), {
        chart: { type: "column" },
        title: { text: "Total MeSH Terms and Keywords" },
        xAxis: { categories: ["MeSH terms", "Keywords"] },
        yAxis: { title: { text: "Total terms" } },
        plotOptions: { column: { colorByPoint: true } },
        colors: [MESH_COLOR, KEYWORD_COLOR],
        series: [{
            name: "Total",
            data: [
                getMeshDescriptors(article).length,
                getKeywords(article).length
            ],
            dataLabels: { enabled: true }
        }]
    });
}

// Horizontal bar chart of the most common terms.
function renderTopTermsChart(parent, title, subtitle, color, entries) {
    const container = createChartContainer(parent);

    if (entries.length === 0) {
        container.textContent = `${title}: no data available.`;
        return;
    }

    renderChart(container, {
        chart: { type: "bar" },
        title: { text: title },
        subtitle: { text: subtitle },
        xAxis: { categories: entries.map(([term]) => term) },
        yAxis: { title: { text: "Number of articles" } },
        tooltip: { pointFormat: "<b>{point.y}</b> article(s)" },
        series: [{
            name: "Articles",
            color,
            data: entries.map(([, count]) => count)
        }]
    });
}

// Column (vertical bar) chart: number of similar articles published per year.
// The x axis spans the earliest to latest year among the similar articles.
function renderPublicationChart(articles, parent) {
    const container = createChartContainer(parent);
    const dated = articles.filter(article => Number.isInteger(article.year));
    const undatedCount = articles.length - dated.length;

    if (dated.length === 0) {
        container.textContent =
            "Articles published over time: no publication years available.";
        return;
    }

    const years = dated.map(article => article.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);

    // One point per year in the range (years with no articles = 0).
    const categories = [];
    const data = [];

    for (let year = minYear; year <= maxYear; year++) {
        const inYear = dated.filter(article => article.year === year);

        categories.push(String(year));
        data.push({
            y: inYear.length,
            articles: inYear.map(({ pmid, title }) => ({ pmid, title }))
        });
    }

    renderChart(container, {
        chart: { type: "column" },
        title: { text: "Similar Articles Published Over Time" },
        subtitle: {
            text: undatedCount > 0
                ? `${undatedCount} article(s) without a publication year not shown`
                : undefined
        },
        xAxis: {
            categories,
            title: { text: "Publication year" }
        },
        yAxis: { title: { text: "Number of articles" } },
        tooltip: {
            useHTML: true,
            formatter: function() {
                const list = this.point.articles;

                if (list.length === 0) {
                    return `<b>${this.x}</b><br>No articles`;
                }

                const items = list.map(article =>
                    `<div style="max-width:320px;white-space:normal;margin-top:4px">` +
                    `<b>PMID ${escapeHtml(article.pmid)}</b><br>` +
                    `${escapeHtml(article.title || "Untitled article")}</div>`
                ).join("");

                return `<b>${this.x}</b> (${list.length} article${list.length === 1 ? "" : "s"})${items}`;
            }
        },
        series: [{
            name: "Articles",
            color: "#3a8f5c",
            data
        }]
    });
}

// Remove charts from a previous search.
function clearResults() {
    Highcharts.charts.filter(Boolean).forEach(chart => chart.destroy());
    results.replaceChildren();
}

// ---------- Form handling ----------

// The submit button stays disabled until an option is chosen.
function syncSubmitState() {
    button.disabled = !VALID_SCOPES.includes(scopeSelect.value);
}

scopeSelect.addEventListener("change", () => {
    scopeSelect.removeAttribute("aria-invalid");
    syncSubmitState();
});

syncSubmitState();

form.addEventListener("submit", async function(event) {
    event.preventDefault();

    clearResults();

    const pmid = input.value.trim();

    if (!VALID_SCOPES.includes(scopeSelect.value)) {
        statusMessage.textContent =
            "Please select a results option before submitting.";
        scopeSelect.setAttribute("aria-invalid", "true");
        return;
    }

    if (!/^[0-9]+$/.test(pmid)) {
        statusMessage.textContent =
            "Please enter a valid numeric PubMed ID.";
        input.setAttribute("aria-invalid", "true");
        return;
    }

    const requestedSimilar = Number(scopeSelect.value); // 0, 5, or 10

    input.removeAttribute("aria-invalid");
    button.disabled = true;
    statusMessage.textContent = "Loading article...";

    try {
        const original = await fetchPubMedArticle(pmid);

        displayTitleAndAbstract(original, results);

        // ----- Single article: title, abstract, terms table, totals chart.
        if (requestedSimilar === 0) {
            displayTermsTable(original, results);
            renderTotalsChart(original, results);

            statusMessage.textContent = "Complete. Retrieved the article.";
            console.log("Original article:", original);
            return;
        }

        // ----- With similar articles: title, abstract, totals chart first.
        renderTotalsChart(original, results);

        statusMessage.textContent =
            "Original article retrieved. Finding similar articles...";

        const similar = await fetchSimilarArticles(original.pmid, requestedSimilar);

        if (similar.length === 0) {
            results.appendChild(createElement(
                "p",
                "No similar articles were found for this PubMed ID.",
                "note"
            ));
        } else {
            const noteText = similar.length < requestedSimilar
                ? `Only ${similar.length} similar article(s) exist for this PubMed ID ` +
                  `(${requestedSimilar} requested). Results below use ${similar.length}.`
                : `Showing ${similar.length} similar articles.`;

            results.appendChild(createElement("p", noteText, "note"));

            const all = [original, ...similar];
            const subtitle =
                `Across the submitted article and ${similar.length} similar article(s)`;

            renderTopTermsChart(
                results,
                "Top 5 MeSH Terms",
                subtitle,
                MESH_COLOR,
                topTerms(countTerms(all, getMeshDescriptors))
            );

            renderTopTermsChart(
                results,
                "Top 5 Keywords",
                subtitle,
                KEYWORD_COLOR,
                topTerms(countTerms(all, getKeywords))
            );

            renderPublicationChart(similar, results);

            displaySimilarArticlesTable(similar, results);
        }

        statusMessage.textContent =
            `Complete. Retrieved the original article and ${similar.length} similar article(s).`;

        console.log("Original article:", original);
        console.log("Similar articles:", similar);

    } catch (error) {
        statusMessage.textContent = error.message;
        console.error("PubMed API error:", error);

    } finally {
        syncSubmitState();
    }
});
