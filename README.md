### Local Build and Deployment Guide

This guide outlines the steps to compile the TypeScript extension into standard JavaScript, fix the generated deep-links, and push the updates to the GitHub Pages environment. (For Windows and mostly as notes to self)

# 1. Compile the Source Code

Ensure you are checked out to your main working branch (e.g., 0.8) and your terminal is open to the pb-extensions root directory.

Run the following commands in the Windows Command Prompt (CMD) to set the repository path and build the bundle:
```
set GITHUB_REPOSITORY=acepilot147/pb-extensions/0.8
npm run bundle
```

Should see logs such as:
```
E:\GitHub\acepilot147-comix\pb-extensions>set GITHUB_REPOSITORY=acepilot147/pb-extensions    

E:\GitHub\acepilot147-comix\pb-extensions>npx paperback bundle --folder 0.8
[15:09:16:0155] Working directory: E:\GitHub\acepilot147-comix\pb-extensions
[15:09:16:0156] 
[15:09:16:0197] # Transpile and bundle time: 37ms
[15:09:16:0197] 
[15:09:16:0203] # Versioning File: 5ms
[15:09:16:0203]
[15:09:16:0204] - Generating the repository homepage
[15:09:16:0205] Using base URL deducted from GITHUB_REPOSITORY environment variable: https://acepilot147.github.io/pb-extensions/0.8
[15:09:16:0273] # Homepage Generation: 69ms
[15:09:16:0273] 
[15:09:16:0273] # Execution time: 116ms
```

# 2. Deploy to GitHub Pages

The compiled files must be moved to the gh-pages branch to go live.

Commit source code: Save your current work on your working branch.
```
git add .
git commit -m "Update extension source code"
```

Switch branches: Move to the deployment branch.
```
git checkout gh-pages
```

Transfer files: Copy all contents from your local output folder (bundles/ or dist/) and paste them directly into the 0.8 folder on the gh-pages branch, overwriting the old files.

```
git add 0.8/
git commit -m "Deploy updated extension bundle to 0.8"
git push origin gh-pages
```