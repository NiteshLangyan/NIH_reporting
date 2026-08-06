const path = require('path');

let extractorPromise = null;

// Lazy-load the local embedding model from the model files bundled in this
// repo's models/ directory — required for Vercel's serverless deployment,
// where the filesystem is read-only and there is no runtime network fetch
// for large binary assets. Falls back to the library's normal
// download-and-cache behavior when running somewhere with a writable
// filesystem and the bundled files aren't present (e.g. a fresh local
// checkout before `models/` has been populated).
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');

      const bundledModelPath = path.join(__dirname, 'models');
      const fs = require('fs');
      if (fs.existsSync(path.join(bundledModelPath, 'Xenova', 'all-MiniLM-L6-v2'))) {
        env.localModelPath = bundledModelPath;
        env.allowRemoteModels = false;
      }

      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
  }
  return extractorPromise;
}

async function embedText(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Vectors from embedText are already L2-normalized, so dot product == cosine similarity.
  return dot;
}

module.exports = { embedText, cosineSimilarity };
