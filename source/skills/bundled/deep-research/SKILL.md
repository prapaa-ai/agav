---
name: deep-research
description: Multi-source research on a topic with citations
version: 1.0.0
invocation: user
allowed-tools:
  - web_search
  - fetch_url
  - read_file
  - write_file
tags:
  - research
  - analysis
---

# Deep Research

Conduct thorough multi-source research on a topic, verify claims, and produce a cited report.

## Instructions

1. Clarify the research question. If the user's query is too broad or ambiguous, ask 2-3 focused questions to narrow the scope before proceeding.
2. Search for information across multiple sources using varied search queries. Use at least 3 different query phrasings to ensure breadth.
3. Fetch and read the most relevant sources. Prioritize authoritative sources: official documentation, peer-reviewed papers, reputable publications, primary data.
4. Cross-reference key claims across at least 2 independent sources. Flag any contradictions or disputed points.
5. Verify factual claims (statistics, dates, technical specifications) against primary sources where possible.
6. Synthesize findings into a structured report:
   - **Summary**: Key findings in 2-3 sentences.
   - **Detailed Analysis**: Organized by subtopic with evidence and reasoning.
   - **Considerations**: Trade-offs, limitations, or open questions.
   - **Sources**: Full list of sources with titles and URLs.
7. Cite sources inline using numbered references (e.g., [1], [2]) linked to the sources list.
8. Distinguish between well-established facts, expert opinions, and uncertain claims.
9. If the user requests, write the report to a file. Otherwise, present it directly.
