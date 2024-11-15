const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { URL } = require('url');
const cliProgress = require('cli-progress');
const colors = require('colors');
const { MAX_WORKERS, RATE_LIMIT_DELAY } = require('./config');

if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY environment variable is not set');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

function getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function createProgressBar(domain) {
    return new cliProgress.SingleBar({
        format: colors.magenta(`${domain} |{bar}| {percentage}%`),
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
    }, cliProgress.Presets.shades_classic);
}

function isValidKeyword(keyword) {
    const words = keyword.split(' ').filter(word => word.trim());
    return words.length >= 2;
}

async function processSitemap(sitemapUrl) {
    const maxRetries = 3;
    let attempts = 0;
    
    while (attempts < maxRetries) {
        try {
            const domain = new URL(sitemapUrl).hostname;
            const timestamp = getTimestamp();
            const outputDir = path.join('output', `${domain}_${timestamp}`);
            let randomKeyword = 'None';
            
            await fs.mkdir(outputDir, { recursive: true });
            
            const response = await axios.get(sitemapUrl);
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(response.data);
            
            const { keywords, phrases } = result.urlset.url
                .map(urlEntry => urlEntry.loc[0])
                .filter(url => !/(blog|blogs|blogging|blog-post|blog-posts)/i.test(url))
                .map(url => {
                    const withoutDomain = url.replace(/^https?:\/\/[^\/]+/, '');
                    const withoutSlashes = withoutDomain.replace(/^\/|\/$/g, '').replace(/\.html$|\.php$/g, '');
                    const words = withoutSlashes.replace(/-/g, ' ')
                        .split(' ')
                        .filter(word => word.trim().length > 0);
                    
                    const transformedWords = words.map((word, index) => {
                        if (index === words.length - 1 && word.toLowerCase() === 'nj') {
                            return word.toUpperCase();
                        }
                        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
                    });
                    
                    return transformedWords.join(' ');
                })
                .filter(text => text.length > 0)
                .reduce((acc, phrase) => {
                    if (phrase.endsWith('NJ') && isValidKeyword(phrase)) {
                        acc.keywords.push(phrase);
                    } else if (!phrase.endsWith('NJ') && isValidKeyword(phrase)) {
                        acc.phrases.push(phrase);
                    }
                    return acc;
                }, { keywords: [], phrases: [] });

            await Promise.all([
                fs.writeFile(path.join(outputDir, `keywords_${timestamp}.txt`), keywords.join('\n')),
                fs.writeFile(path.join(outputDir, `phrases_${timestamp}.txt`), phrases.join('\n'))
            ]);

            if (keywords.length > 0) {
                randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];
                const article = await generateArticle(randomKeyword);
                const safeFileName = randomKeyword.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                await fs.writeFile(path.join(outputDir, `${safeFileName}_${timestamp}.txt`), article);
            }

            return {
                domain,
                outputDir,
                keywordCount: keywords.length,
                phraseCount: phrases.length,
                processedKeyword: randomKeyword
            };
        } catch (error) {
            attempts++;
            console.error(`Attempt ${attempts} failed for ${sitemapUrl}: ${error.message}`);
            if (attempts === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY * attempts));
        }
    }
}

async function generateArticle(keyword) {
    const maxRetries = 3;
    let attempts = 0;

    while (attempts < maxRetries) {
        try {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
            
            const completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "You are a professional content writer specializing in local service businesses." },
                    { role: "user", content: `Write a 500 word SEO-optimized article about ${keyword}. Include specific details about the service, how the area is being served, benefits to customers, and end with a clear call to action` }
                ],
                temperature: 0.7,
                max_tokens: 800
            });

            return completion.choices[0].message.content;
        } catch (error) {
            attempts++;
            console.error(`Attempt ${attempts} failed for ${keyword}: ${error.message}`);
            if (attempts === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY * attempts));
        }
    }
}

async function main() {
    const sitemaps = await fs.readFile('sitemaps.txt', 'utf-8');
    const sitemapUrls = sitemaps
        .split('\n')
        .filter(url => url.trim())
        .filter(url => {
            try {
                new URL(url);
                return true;
            } catch {
                console.error(`Invalid URL: ${url}`);
                return false;
            }
        });
    const workers = new Map();
    const results = [];
    const progressBars = new Map();

    console.log(`Processing ${sitemapUrls.length} sitemaps...`);

    for (const sitemapUrl of sitemapUrls) {
        while (workers.size >= MAX_WORKERS) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        }

        const domain = new URL(sitemapUrl).hostname;
        const progressBar = createProgressBar(domain);
        progressBar.start(100, 0);
        progressBars.set(domain, progressBar);

        const worker = new Worker(__filename, { workerData: sitemapUrl });
        workers.set(worker, sitemapUrl);

        worker.on('message', result => {
            if (result.error) {
                console.error(`\nFailed processing ${sitemapUrl}: ${result.error}`);
                progressBars.get(domain).stop();
            } else {
                progressBars.get(domain).update(100);
                results.push(result);
                console.log(`\nCompleted ${result.domain}: ${result.keywordCount} keywords, ${result.phraseCount} phrases`);
            }
        });

        worker.on('error', error => {
            console.error(`\nWorker error for ${sitemapUrl}:`, error);
            progressBars.get(domain).stop();
        });

        worker.on('exit', () => {
            workers.delete(worker);
            const progressBar = progressBars.get(domain);
            progressBar.stop();
            progressBars.delete(domain);
        });

        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
    }

    const workerPromises = Array.from(workers.keys()).map(worker => 
        new Promise(resolve => worker.on('exit', resolve))
    );
    await Promise.allSettled(workerPromises);

    const timestamp = getTimestamp();
    const summaries = results.map(r => 
        `${r.domain}: ${r.keywordCount} keywords, ${r.phraseCount} phrases, processed keyword: ${r.processedKeyword}`
    );
    
    await Promise.all(results.map(async r => {
        await fs.writeFile(path.join(r.outputDir, `summary_${timestamp}.txt`), 
            summaries.find(s => s.startsWith(r.domain))
        );
    }));

    const totalArticles = results.filter(r => r.processedKeyword !== 'None').length;
    console.log(`\nAll processing complete. ${totalArticles} articles generated. See output folders for details.`);
}

if (!isMainThread) {
    processSitemap(workerData)
        .then(result => parentPort.postMessage(result))
        .catch(error => parentPort.postMessage({ error: error.message }));
} else {
    main().catch(console.error);

    process.on('SIGINT', () => {
        console.log('\nGracefully shutting down...');
        for (const worker of workers.keys()) {
            worker.terminate();
        }
        process.exit(0);
    });
}