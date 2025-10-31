if(treatmentText){
  treatmentText.textContent = resultText;
  treatmentText.dataset.locked = '1';
}
if(pre) pre.textContent = typeof resultText === 'string' ? resultText : JSON.stringify(resultText, null, 2);