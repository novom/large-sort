import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import { sort } from 'fast-sort';

// Global variable to collect all the cleanup functions
const sortFileToClean = new Array<() => void>();

function cleanup(): void {
    for(let i = 0; i < sortFileToClean.length; i++) {
        try {
            let cleanFn = sortFileToClean[i];
            cleanFn()
        } catch {
            // Ignore errors
        }
    }
}

process.on('exit', cleanup);

/**
 * Function to sorts the file into another file.
 * 
 * @param inputFile File path to load and sort
 * @param outputFile File path to output the sorted {@link inputFile}
 * @param inputMapFn Function to deserialize the input from each file line.
 * @param outputMapFn Function serialize each of the {@link TValue} to a string.
 * @param compareFn Function used to sort the {@link TValue} for each of the files.
 * @param linesPerFile Number of lines processed before writting a split file.
 */
export default async function sortFile<TValue>(
    inputFile: string,
    outputFile: string,
    inputMapFn: (x: string) => TValue,
    outputMapFn: (x:TValue) => string,
    extractSortPropertyFn: (x: TValue) => any = (x) => x,
    linesPerFile: number = 100000) {
        const base = path.join(os.tmpdir(), 'large-sort');
        if(!fs.existsSync(base)) {
            fs.mkdirSync(base, {recursive: true});
        }
        const tempFolder = fs.mkdtempSync(path.join(base, "temp_"));
        const tempFiles = new Array<string>();

        sortFileToClean.push(() => deleteFiles(tempFolder));

        try {
            console.debug(`[SortFile] started split of file "${inputFile}". ${new Date().toLocaleString()}`);
            console.time(`[SortFile] finished split of file "${inputFile}" time`);
            await split(inputFile, tempFolder, tempFiles, inputMapFn, JSON.stringify, extractSortPropertyFn, linesPerFile);
            console.timeEnd(`[SortFile] finished split of file "${inputFile}" time`);

            console.debug(`[SortFile] started merge to file "${outputFile}". ${new Date().toLocaleString()}`);
            console.time(`[SortFile] finished merge to file "${outputFile}" time`);
            await merge(tempFiles, outputFile, JSON.parse, outputMapFn, extractSortPropertyFn, linesPerFile);
            console.timeEnd(`[SortFile] finished merge to file "${outputFile}" time`);
        }
        finally {
            deleteFiles(tempFolder);
        }
    }

function deleteFiles(tempFolder: string) {
    try {
        fs.rmdirSync(tempFolder);
    }
    catch {}
}

/**
 * Function to split the file into multiple files with sorted data which are populated to the {@link outputFiles} parameter.
 * 
 * @param filePath File path of the 
 * @param splitPath The base path on where the files will be splited to.
 * @param outputFiles List that will be populated with the output files.
 * @param inputMapFn Function to deserialize the input from each file line into a {@link TValue}.
 * @param outputMapFn Function serialize each of the {@link TValue} to a string.
 * @param compareFn Function used to sort the {@link TValue} for each of the files.
 * @param linesPerFile How many lines process for each file.
 */
async function split<TValue>(
    filePath: string,
    splitPath: string,
    outputFiles: Array<string>,
    inputMapFn: (x: string) => TValue,
    outputMapFn: (x:TValue) => string,
    extractSortPropertyFn: (x: TValue) => any,
    linesPerFile: number): Promise<void> {
        linesPerFile = Math.floor(linesPerFile);

        const compareFn = (a:TValue, b:TValue) => extractSortPropertyFn(a) > extractSortPropertyFn(b) ? 1 : -1;
        const sortFn: (x: TValue[]) => TValue[] = 
            (x: TValue[]) => 
                x.length > 1500 ? sort(x).asc([extractSortPropertyFn]) :
                x.sort(compareFn);
        
        const readStream = fs.createReadStream(filePath, {highWaterMark: 1_000_000, flags: 'r'});
        const reader = readline.createInterface({
            input: readStream
        });
        let linesLoaded = 0;
        let buffer: Array<TValue> = new Array<TValue>();
        reader.on('line', (line) => {
            if(line.trim() != '')
                buffer.push(inputMapFn(line));
            linesLoaded++;
            if(linesLoaded % 1000000 == 0) {
                console.debug(`[SortFile] ("${filePath}"): loaded ${linesLoaded.toLocaleString()} lines. ${new Date().toLocaleString()}`);
            }

            // Flush buffer at the specified lines per file or when it is using more than 1GB of RAM
            if (linesLoaded % linesPerFile == 0 || (linesLoaded % 1000 == 0 && (process.memoryUsage().heapUsed / 1024 / 1024 / 1024) > 1)) {
                let bufferCopy = buffer;
                buffer = new Array<TValue>();
                flushBuffer(bufferCopy, linesLoaded, splitPath, outputFiles, outputMapFn, sortFn);
            }
        });
        // Wait till it finishes reading the file
        await new Promise<void>((resolve) => reader.once('close', resolve));
        readStream.close()
        // Process the last buffer if needed
        if(buffer.length != 0) {
            flushBuffer(buffer, linesLoaded, splitPath, outputFiles, outputMapFn, sortFn);
        }
        console.debug(`[SortFile] ("${filePath}"): loaded ${linesLoaded.toLocaleString()} lines. ${new Date().toLocaleString()}`);
}

/**
 * Helper function to process the buffer.
 * 
 * @param buffer Data buffer to write
 * @param linesLoaded Numbers of already loaded lines
 * @param splitPath Folder where the files are going to be stored
 * @param promises Array of promises to be eventually awaited
 * @param outputFiles Array of the resulting file names.
 * @param outputMapFn Function serialize each of the {@link TValue} to a string.
 * @param compareFn Function used to sort the {@link TValue} for each of the files.
 */
function flushBuffer<TValue>(
    buffer: Array<TValue>,
    linesLoaded: number,
    splitPath: string,
    outputFiles: Array<string>,
    outputMapFn: (x:TValue) => string,
    sortFn: (x: TValue[]) => TValue[]) {
        const filename = path.join(splitPath, `large-sort_${String(linesLoaded).padStart(10, '0')}.txt`);
        // console.time(`[SortFile.Split] Sort ${buffer.length} items time`);
        let sorted = sortFn(buffer);
        // console.timeEnd(`[SortFile.Split] Sort ${buffer.length} items time`);
        // console.time('[SortFile.Split]  Map items time')
        let mapped = sorted.map(outputMapFn)
        mapped.push(''); // Extra so it has a new line at the end.
        // console.timeEnd('[SortFile.Split]  Map items time')

        // console.time('[SortFile.Split]  String Join items time')
        let toWrite = mapped.join('\n')
        // console.timeEnd('[SortFile.Split]  String Join items time')
        
        // console.time('[SortFile.Split]  Write to disk time')
        fs.writeFileSync(filename, toWrite)
        // console.timeEnd('[SortFile.Split]  Write to disk time')
        outputFiles.push(filename);
}

async function merge<TValue>(
    files: Array<string>,
    resultFile: string,
    inputMapFn: (x: string) => TValue,
    outputMapFn: (x:TValue) => string,
    extractSortPropertyFn: (x: TValue) => any,
    linesPerFile: number): Promise<void> {
        type MergerInfo = {
            data: TValue,
            done: boolean,
            iter: AsyncIterableIterator<string>,
            reader: readline.Interface,
            readStream: fs.ReadStream
        }
        let readers = new Array<MergerInfo>();
        let mergedItems = 0;
        // Create readers
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const readStream = fs.createReadStream(f, { highWaterMark: 1_000_000, flags: 'r'});
            const reader = readline.createInterface({
                input: readStream,
                crlfDelay: Infinity
            });
            const iterator: AsyncIterableIterator<string> = reader[Symbol.asyncIterator]();
            const firstNext = await iterator.next();
            if(!(firstNext.done?? false)) { 
                readers.push({
                    data: inputMapFn(firstNext.value), 
                    done: firstNext.done ?? false,
                    iter: iterator,
                    reader: reader,
                    readStream: readStream
                });
            }
            else {
                reader.close()
                readStream.close();
            }
        }

        const descCompareFn = (a:MergerInfo, b:MergerInfo) => extractSortPropertyFn(a.data) < extractSortPropertyFn(b.data)? 1 : -1;
        const descSortFn: (x: MergerInfo[]) => MergerInfo[] = 
            (array: MergerInfo[]) => 
                array.length > 1500 ?
                    sort(array).desc([x => extractSortPropertyFn(x.data)]) : 
                    array.sort(descCompareFn);

        // Reverse sort based on the to do the merge
        readers = descSortFn(readers);
        
        var resultStream = fs.createWriteStream(resultFile, {highWaterMark: 10_000_000, flags: 'w'});
        let writeBuffer = new Array<string>();
        let previousPromise: Promise<void> = Promise.resolve();
        let bufferStringSize = 0;
        const maxStringLength = Math.pow(2, 23) * .90; // 90% of the node js string max length
        // Wait till the result stream is open
        await new Promise<void>((r) => resultStream.once('open', () => r()));
        //resultStream.once('open', async (fd) => {
        while(readers.length > 0) {
            const mergerInfo: MergerInfo = readers[readers.length - 1];
            readers.length--;
            mergedItems++;
            let dataStr = outputMapFn(mergerInfo.data);
            writeBuffer.push(dataStr);
            bufferStringSize += dataStr.length;
            if(writeBuffer.length > linesPerFile || bufferStringSize > maxStringLength) {
                writeBuffer.push('')
                let bufferStr = writeBuffer.join('\n');
                writeBuffer = new Array<string>();
                bufferStringSize = 0;
                await previousPromise;
                previousPromise = new Promise<void>(
                    (res) => 
                        resultStream.write(
                            bufferStr,
                            () => res())
                );
                // resultStream.write(bufferStr);
            }
            if(mergedItems % 1000000 == 0) {
                console.debug(`[SortFile] ${mergedItems.toLocaleString()} merged items.`);
            }
            var next: any;
            do {
                next = await mergerInfo.iter.next();
            } while(next.value == undefined && !(next.done?? false))
            if (!(next.done?? false)) {
                mergerInfo.data = inputMapFn(next.value);
                mergerInfo.done = next.done ?? false;
                // Reverse sort again based on the added new data.
                let insertIdx = binarySearch(mergerInfo, readers, descCompareFn);
                readers.splice(insertIdx, 0, mergerInfo);
            }
            else {
                mergerInfo.reader.close();
                mergerInfo.readStream.close();
            }
        }
        // Wait for the last promise
        await previousPromise;

        // Flush the last buffer
        if(writeBuffer.length > 0) {
            mergedItems += writeBuffer.length;
            await new Promise<void>((resolve) => resultStream.write(writeBuffer.join('\n'), () => resolve()));
            console.debug(`[SortFile] ${mergedItems.toLocaleString()} merged items.`);
        }
        resultStream.close();
}

function binarySearch<T>(
    ti: T, 
    ar: T[],
    compareFn:  (a:T, b:T) => number): number {
        let start = 0;
        let end = ar.length;
        while(start != end - 1) {
            let mid = Math.floor((start + end) / 2);
            let pivot = ar[mid];
            if(mid == 0) {
                return mid;
            }
            let beforePivot = ar[mid - 1];
            if(compareFn(pivot, ti) > 0 && compareFn(beforePivot, ti) < 0)
            {
                return mid;
            }
            else if(compareFn(pivot, ti) > 0) {
                end = mid;
            }
            else {
                start = mid;
            }
        }
        if(start == ar.length - 1 && compareFn(ar[start], ti) < 0) {
            return start + 1;
        }
        return start;
}