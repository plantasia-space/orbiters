import fs from 'fs';
import jsdoc2md from 'jsdoc-to-markdown';

// Generate the documentation
async function generateDocs() {
  try {
    const docs = await jsdoc2md.render({
      files: 'src/**/*.js',
      'heading-depth': 2, // Start headings at h2 level
    });
    
    // Fix potential MDX parsing issues
    const sanitizedDocs = docs
      // Escape curly braces in code blocks to prevent MDX interpretation
      .replace(/\{([^}]*)\}/g, (match) => {
        // Don't replace curly braces in places that look like JSX/MDX tags
        if (match.includes('<') || match.includes('>')) {
          return match;
        }
        // Replace with escaped versions
        return '\\{' + match.slice(1, -1) + '\\}';
      })
      // Replace problematic code block identifiers with escaped versions
      .replace(/`<code>([^`]*)<\/code>`/g, '`\\<code>$1\\</code>`')
      // Replace any remaining HTML-like tags in code sections
      .replace(/(`[^`]*)<([^>]+)>([^`]*`)/g, '$1&lt;$2&gt;$3')
      // Escape pipe characters in table rows to prevent MDX parsing issues
      .replace(/\|\s*([^|]*\{[^}]*\}[^|]*)\s*\|/g, '| $1 |')
      // Handle angle brackets in inline code
      .replace(/`([^`]*)<([^`>]*?)>([^`]*)`/g, '`$1&lt;$2&gt;$3`')
      // Ensure proper escape for JSX-like syntax
      .replace(/<(\/?)([A-Za-z0-9_]+)(\s|>)/g, '&lt;$1$2$3');

// Add Docusaurus frontmatter
const docusaurusDocs = `---
id: reference
title: Entangled Worlds Reference
sidebar_label: Reference Documentation
---

${sanitizedDocs}`;

// Create the directory if it doesn't exist
const outputDir = './entangled-worlds-reference/docs';
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write the documentation to a file
fs.writeFileSync(`${outputDir}/reference.md`, docusaurusDocs);

console.log('Documentation generated successfully.');
  } catch (error) {
    console.error('Error generating documentation:', error);
  }
}

// Execute the function
generateDocs();