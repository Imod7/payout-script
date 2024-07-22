# payout-scripts
Scripts for staking-payouts in Polkadot and Kusama.

### Prerequisites
- Have nodejs installed on your machine 
     - Linux `sudo apt install nodejs`
- Install the `polkadot/api` package with the command `npm install @polkadot/api`

### How to start
- Clone this repository
- Move into the cloned repo with `cd payout-script`

## Polkadot

### Run Polkadot script
- You can run the Polkadot script with the corresponding arguments as shown below:
    ```
    $ node polkadot-script.js <validatorAddress> <eraStart> <eraEnd> <urlEndpoint>
    ```
- An example would be :
    ```shell script
    $ node polkadot-script.js 15a9ScnYeVfQGL9HQtTn3nkUY1DTB8LzEX391yZvFRzJZ9V7 1300 1320 wss://rpc.polkadot.io
    ```

### Things to consider
Public endpoints like `wss://rpc.polkadot.io` have rate limit so if you query for a lot of validators and eras you might get banned.

### Troubleshooting
When you run the script, if you get the following error:

````
TypeError: Cannot read properties of undefined (reading 'block_number')
````

this means that the entries in the [polkadotErasInfo.js](./polkadotErasInfo.js) file need to be updated to include more eras.

### Output
The result is saved in the file `validatorPayouts.json` in the following format: 

```json
{
  "validatorPayouts": [
     {
      "validatorId": "15a9ScnYeVfQGL9HQtTn3nkUY1DTB8LzEX391yZvFRzJZ9V7",
      "era": 1300,
      "payout": "115988858522",
      "wasClaimed": "true",
      "activeValidator": "true"
    },
    {
      "validatorId": "15a9ScnYeVfQGL9HQtTn3nkUY1DTB8LzEX391yZvFRzJZ9V7",
      "era": 1301,
      "payout": "115404066247",
      "wasClaimed": "true",
      "activeValidator": "true"
    },
    ...
    ...
  ]
}
```

### Access Output data
In order to access the output data you could do the following: 
```js
const jsonData = fs.readFileSync('validatorPayouts.json', 'utf8');
const validatorPayouts = JSON.parse(jsonData);
console.log(validatorPayouts.validatorPayouts[0]);
```

which will return the first object from the output

```json
{
    "validatorId": "15a9ScnYeVfQGL9HQtTn3nkUY1DTB8LzEX391yZvFRzJZ9V7",
    "era": 1400,
    "payout": "119021393783",
    "wasClaimed": "true",
    "activeValidator": "true"
}
```

## Kusama
- For the script to run you need to specify some parameters in the file `scriptParams.js` which are the following :
    - validatorId
    - eraStart
    - eraEnd
    - url
- The current file has already an example with values you can replace.
- You can run the Kusama script by giving the following command:
    ```
    $ node kusama-script.js
    ```

### Things to consider
The message:
````
Unable to map [u8; 32] to a lookup index
````
printed in the output after each result is not an error (and not directly related to the current script) so it can be ignored.


### Output
The result is saved in the file `validatorPayouts.json` in the following format:

```json
{
	"validatorPayouts": [
    {
      "validatorId": "HZUyowqk6wH6o8B4Asf7P7hLuRXy8hPheNCKevN5QFFRRdd",
      "era": 0,
      "payout": "0",
      "activeValidator": "false"
    },
    {
      "validatorId": "HZUyowqk6wH6o8B4Asf7P7hLuRXy8hPheNCKevN5QFFRRdd",
      "era": 1,
      "payout": "0",
      "activeValidator": "false"
    },
    ...
    ...
  ]
}
```
