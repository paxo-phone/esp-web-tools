export const findSubarrayIndex = (
  mainArray: Uint8Array,
  subArray: Uint8Array,
  fromIndex: number = 0,
): number | undefined => {
  const mainLen = mainArray.length;
  const subLen = subArray.length;

  // Edge case: If the subarray is empty, return undefined
  if (subLen === 0) return undefined;

  // Iterate through the main array
  for (let i = fromIndex; i <= mainLen - subLen; i++) {
    // Check if the subarray matches the main array from index i
    let match = true;
    for (let j = 0; j < subLen; j++) {
      if (mainArray[i + j] !== subArray[j]) {
        match = false;
        break;
      }
    }
    // If a match is found, return the starting index
    if (match) return i;
  }

  // If no match is found, return undefined
  return undefined;
};
