// lib/indiaGeoData.js
// Curated India State -> Cities mapping for Delivery Region configuration.

const INDIA_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa',
  'Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala',
  'Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland',
  'Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura',
  'Uttar Pradesh','Uttarakhand','West Bengal',
  'Andaman and Nicobar Islands','Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu','Delhi',
  'Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry',
];

const STATE_CITIES = {
  'Andhra Pradesh':['Visakhapatnam','Vijayawada','Guntur','Nellore','Kurnool','Kakinada','Rajahmundry','Tirupati','Eluru','Anantapur','Kadapa','Srikakulam','Vizianagaram','Ongole','Chittoor','Hindupur','Bhimavaram','Machilipatnam','Tenali','Proddatur'],
  'Arunachal Pradesh':['Itanagar','Naharlagun','Pasighat','Namsai','Tezu','Ziro','Bomdila','Tawang','Along','Khonsa'],
  'Assam':['Guwahati','Dibrugarh','Silchar','Jorhat','Nagaon','Tinsukia','Tezpur','Bongaigaon','Diphu','Sivasagar','Goalpara','Lakhimpur','Dhubri','Barpeta','Karimganj'],
  'Bihar':['Patna','Gaya','Bhagalpur','Muzaffarpur','Darbhanga','Purnia','Arrah','Bihar Sharif','Begusarai','Katihar','Munger','Chapra','Hajipur','Samastipur','Sitamarhi','Motihari','Sasaram','Bettiah','Aurangabad','Nawada'],
  'Chhattisgarh':['Raipur','Bhilai','Bilaspur','Korba','Durg','Rajnandgaon','Raigarh','Jagdalpur','Ambikapur','Dhamtari'],
  'Goa':['Panaji','Vasco da Gama','Margao','Mapusa','Ponda','Bicholim','Curchorem','Valpoi','Sanquelim','Canacona'],
  'Gujarat':['Ahmedabad','Surat','Vadodara','Rajkot','Bhavnagar','Jamnagar','Junagadh','Gandhinagar','Anand','Navsari','Morbi','Surendranagar','Bharuch','Patan','Mehsana','Gandhidham','Valsad','Amreli','Porbandar','Botad'],
  'Haryana':['Faridabad','Gurugram','Panipat','Ambala','Yamunanagar','Rohtak','Hisar','Karnal','Sonipat','Panchkula','Bhiwani','Sirsa','Bahadurgarh','Jind','Thanesar','Kaithal','Rewari','Palwal','Fatehabad','Narnaul'],
  'Himachal Pradesh':['Shimla','Dharamshala','Solan','Mandi','Baddi','Kullu','Una','Nahan','Hamirpur','Bilaspur'],
  'Jharkhand':['Ranchi','Jamshedpur','Dhanbad','Bokaro','Deoghar','Phusro','Hazaribagh','Giridih','Ramgarh','Medininagar'],
  'Karnataka':['Bengaluru','Mysuru','Hubballi','Mangaluru','Belagavi','Kalaburagi','Ballari','Davangere','Shivamogga','Tumakuru','Bidar','Raichur','Vijayapura','Udupi','Hassan','Dharwad','Chitradurga','Bagalkot','Hospet','Gadag'],
  'Kerala':['Thiruvananthapuram','Kochi','Kozhikode','Kollam','Thrissur','Alappuzha','Palakkad','Malappuram','Kannur','Kottayam','Kasaragod','Pathanamthitta','Idukki','Wayanad','Ernakulam'],
  'Madhya Pradesh':['Indore','Bhopal','Jabalpur','Gwalior','Ujjain','Sagar','Dewas','Satna','Ratlam','Rewa','Murwara','Singrauli','Burhanpur','Khandwa','Bhind','Chhindwara','Guna','Shivpuri','Vidisha','Chhatarpur'],
  'Maharashtra':['Mumbai','Pune','Nagpur','Nashik','Thane','Aurangabad','Solapur','Kolhapur','Amravati','Nanded','Sangli','Jalgaon','Akola','Latur','Dhule','Ahmednagar','Chandrapur','Parbhani','Navi Mumbai','Vasai-Virar','Bhiwandi','Malegaon','Ulhasnagar','Ratnagiri','Satara'],
  'Manipur':['Imphal','Thoubal','Bishnupur','Churachandpur','Senapati'],
  'Meghalaya':['Shillong','Tura','Jowai','Nongstoin','Williamnagar'],
  'Mizoram':['Aizawl','Lunglei','Saiha','Champhai','Kolasib'],
  'Nagaland':['Kohima','Dimapur','Mokokchung','Tuensang','Wokha'],
  'Odisha':['Bhubaneswar','Cuttack','Rourkela','Brahmapur','Sambalpur','Puri','Balasore','Bhadrak','Baripada','Jharsuguda','Jeypore','Bargarh','Paradip','Angul','Dhenkanal'],
  'Punjab':['Ludhiana','Amritsar','Jalandhar','Patiala','Bathinda','Mohali','Hoshiarpur','Gurdaspur','Pathankot','Moga','Firozpur','Barnala','Fatehgarh Sahib','Sangrur','Muktsar'],
  'Rajasthan':['Jaipur','Jodhpur','Kota','Bikaner','Ajmer','Udaipur','Bhilwara','Alwar','Bharatpur','Sikar','Sri Ganganagar','Pali','Tonk','Dausa','Barmer','Jhalawar','Nagaur','Sawai Madhopur','Churu','Hanumangarh'],
  'Sikkim':['Gangtok','Namchi','Mangan','Gyalshing','Rangpo'],
  'Tamil Nadu':['Chennai','Coimbatore','Madurai','Tiruchirappalli','Salem','Tirunelveli','Tiruppur','Vellore','Erode','Thoothukudi','Dindigul','Thanjavur','Ranipet','Sivakasi','Karur','Udhagamandalam','Hosur','Nagercoil','Kanchipuram','Kumarapalayam','Karaikkudi','Neyveli','Cuddalore','Kumbakonam','Villupuram','Pudukkottai','Dharmapuri','Krishnagiri','Virudhunagar','Nagapattinam','Perambalur','Ariyalur','Ramanathapuram','Theni','Namakkal'],
  'Telangana':['Hyderabad','Warangal','Nizamabad','Karimnagar','Khammam','Ramagundam','Mahbubnagar','Nalgonda','Adilabad','Suryapet','Siddipet','Miryalaguda','Mancherial','Jagtial','Bodhan'],
  'Tripura':['Agartala','Dharmanagar','Udaipur','Kailasahar','Belonia'],
  'Uttar Pradesh':['Lucknow','Kanpur','Ghaziabad','Agra','Varanasi','Meerut','Allahabad','Bareilly','Aligarh','Moradabad','Saharanpur','Noida','Firozabad','Jhansi','Mathura','Muzaffarnagar','Shahjahanpur','Rampur','Ayodhya','Gorakhpur','Sitapur','Lakhimpur Kheri','Gautam Buddha Nagar','Hapur','Etah'],
  'Uttarakhand':['Dehradun','Haridwar','Roorkee','Haldwani','Rudrapur','Kashipur','Rishikesh','Nainital','Almora','Mussoorie'],
  'West Bengal':['Kolkata','Asansol','Siliguri','Durgapur','Bardhaman','Malda','Baharampur','Habra','Jalpaiguri','Kharagpur','Santipur','Balurghat','Medinipur','Haldia','Raiganj','Krishnanagar','Ranaghat','Uluberia','Kanchrapara','Dhulian'],
  'Andaman and Nicobar Islands':['Port Blair','Diglipur','Rangat','Mayabunder','Campbell Bay'],
  'Chandigarh':['Chandigarh'],
  'Dadra and Nagar Haveli and Daman and Diu':['Daman','Diu','Silvassa'],
  'Delhi':['New Delhi','Delhi','Dwarka','Rohini','Janakpuri','Lajpat Nagar','Saket','Connaught Place','Karol Bagh','Pitampura'],
  'Jammu and Kashmir':['Srinagar','Jammu','Anantnag','Sopore','Baramulla','Kathua','Udhampur','Rajouri','Poonch','Kupwara'],
  'Ladakh':['Leh','Kargil'],
  'Lakshadweep':['Kavaratti','Agatti','Amini'],
  'Puducherry':['Puducherry','Karaikal','Mahe','Yanam'],
};

module.exports = { INDIA_STATES, STATE_CITIES };