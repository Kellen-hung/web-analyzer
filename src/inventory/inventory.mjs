import fs from "node:fs/promises";
import path from "node:path";


const EXTENSION_TYPES = new Map([
    [".html", "HTML"],
    [".htm", "HTML"],
    [".js", "JS"],
    [".mjs", "JS"],
    [".css", "CSS"],
    [".json", "JSON"],

    [".png", "IMAGE"],
    [".jpg", "IMAGE"],
    [".jpeg", "IMAGE"],
    [".gif", "IMAGE"],
    [".webp", "IMAGE"],
    [".ico", "IMAGE"],
    [".svg", "IMAGE"],

    [".sh", "SHELL"]
]);


function toWebPath(filePath) {
    return filePath.split(path.sep).join("/");
}

async function readHeader(filePath, length = 256) {
    const file = await fs.open(filePath, "r");

    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, 0);

        return buffer.subarray(0, bytesRead);
    } finally {
        await file.close();
    }
}

async function detectFileType(filePath, relativePath) {
    const header = await readHeader(filePath);

    // ELF magic: 0x7F 'E' 'L' 'F'
    if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
        return "ELF";
    }

    const headerText = header.toString("utf8");

    // Script with shebang.
    if (headerText.startsWith("#!")) {
        const firstLine = headerText.split(/\r?\n/, 1)[0];

        if (/\b(?:ba|da|k|z)?sh\b/.test(firstLine)) {
            return "SHELL";
        }

        return "SCRIPT";
    }

    const extension = path.extname(relativePath).toLowerCase();

    if (EXTENSION_TYPES.has(extension)) {
        return EXTENSION_TYPES.get(extension);
    }

    // .cgi does not necessarily mean binary.
    if (extension === ".cgi") {
        return "CGI";
    }

    // Files under cgi-bin may also be helpers/libraries.
    if (relativePath === "cgi-bin" || relativePath.startsWith("cgi-bin/")) {
        return "BACKEND";
    }

    return "OTHER";
}


async function walkDirectory(rootDirectory, currentDirectory = rootDirectory) {
    const files = [];

    const entries = await fs.readdir(currentDirectory, {
        withFileTypes: true
    });

    for (const entry of entries) {
        const fullPath = path.join(currentDirectory, entry.name);

        if (entry.isDirectory()) {
            files.push(...await walkDirectory(rootDirectory, fullPath));
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const relativePath = toWebPath(path.relative(rootDirectory, fullPath));
        const stat = await fs.stat(fullPath);
        const type = await detectFileType(fullPath, relativePath);

        files.push({
            path: relativePath,
            type,
            size: stat.size,
            fullPath
        });
    }

    return files;
}


export async function buildInventory(wwwDirectory) {
    const files = await walkDirectory(wwwDirectory);

    files.sort((a, b) => a.path.localeCompare(b.path));

    return files;
}